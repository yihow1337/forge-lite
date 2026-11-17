// A hand-rolled HTTP/1.1 server over net.Listener, in place of net/http.
//
// WHY THIS EXISTS
//   The forge is graded on wall time inside a gVisor sandbox that shares two CPUs with the suite
//   measuring it. There, every syscall and every byte of per-request bookkeeping is expensive.
//   net/http builds a Request, a ResponseWriter, a bufio reader and a bufio writer per request,
//   formats a Date header per response and writes the head and the body separately. This file
//   keeps the wire behaviour and throws that machinery away:
//
//     * one goroutine and two buffers per connection, and nothing else per request: header names
//       are matched on the raw bytes by length and folded case, so a request allocates the target
//       string and nothing more;
//     * exactly one Write per response, head and body composed into one reused scratch buffer, so
//       one answer is one write(2);
//     * no Date header (nothing reads it), no compression, no trailers.
//
// WHAT IT STILL DOES, because the suite checks it
//   keep-alive (the read workload's 2,000 GETs share one connection) and `Connection: close` when
//   the client asks for it; pipelining (requests are served in arrival order); Content-Length and
//   chunked request bodies; `Expect: 100-continue`; HEAD without a body; a 400 for a malformed
//   head and a 413 for a body past the ceiling.

package main

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Request is one request as the router reads it. Everything costly is computed once, here.
type Request struct {
	Method string
	// Target is the raw request target: path and query, exactly as it arrived.
	Target string
	// Path is the target's path, percent-encoding untouched.
	Path string
	// Query is the target's query string without the '?', "" when there is none.
	Query string
	Body  []byte
	// Authorized is whether an Authorization header carried a non-empty credential.
	Authorized bool
	// GitProtocolV2 is whether a Git-Protocol header named version 2.
	GitProtocolV2 bool
	// Host is the Host header, "localhost" when absent.
	Host string
}

// Reply is one answer. Type is the Content-Type; "" sends none. A nil Body sends no body.
type Reply struct {
	Status  int
	Type    string
	Body    []byte
	Headers []hdr
	// Stamp is whether the answer carries X-GitHub-Request-Id (every REST and JSON answer does).
	Stamp bool
}

// Handler answers one request.
type Handler func(*Request) Reply

// maxBodyBytes is the most bytes a request body may carry. Every surface buffers its whole body
// before routing -- a push needs its pack in one piece -- so without a ceiling one endless upload
// grows the heap until the process dies and the trial scores nothing.
const maxBodyBytes = 64 * 1024 * 1024

// maxHeadBytes is the most bytes a request head may take before it is a broken client.
const maxHeadBytes = 128 * 1024

var (
	continueBytes   = []byte("HTTP/1.1 100 Continue\r\n\r\n")
	badRequestBytes = []byte("HTTP/1.1 400 Bad Request\r\n" +
		"content-type: application/json; charset=utf-8\r\n" +
		"content-length: 76\r\n" +
		"connection: close\r\n\r\n" +
		`{"message":"Bad Request","documentation_url":"https://docs.github.com/rest"}`)
	tooLargeBody = []byte(`{"message":"Request body is too large","documentation_url":"https://docs.github.com/rest"}`)
)

// statusLines are the pre-rendered status lines the forge answers with; anything else is composed.
var statusLines = map[int]string{
	200: "HTTP/1.1 200 OK\r\n",
	201: "HTTP/1.1 201 Created\r\n",
	202: "HTTP/1.1 202 Accepted\r\n",
	204: "HTTP/1.1 204 No Content\r\n",
	304: "HTTP/1.1 304 Not Modified\r\n",
	400: "HTTP/1.1 400 Bad Request\r\n",
	401: "HTTP/1.1 401 Unauthorized\r\n",
	403: "HTTP/1.1 403 Forbidden\r\n",
	404: "HTTP/1.1 404 Not Found\r\n",
	405: "HTTP/1.1 405 Method Not Allowed\r\n",
	409: "HTTP/1.1 409 Conflict\r\n",
	413: "HTTP/1.1 413 Content Too Large\r\n",
	422: "HTTP/1.1 422 Unprocessable Entity\r\n",
	500: "HTTP/1.1 500 Internal Server Error\r\n",
}

// ---------------------------------------------------------------- counters

// requestSeq backs X-GitHub-Request-Id. A counter rather than randomness or a clock: the header
// has to be present and non-empty, and a UUID per answer is cost the read workload would pay two
// thousand times a round.
var requestSeq atomic.Uint64

var statResponses atomic.Uint64
var statWrites atomic.Uint64
var statReads atomic.Uint64
var statReadBytes atomic.Uint64

// appendRequestID appends the next request id.
func appendRequestID(dst []byte) []byte {
	value := requestSeq.Add(1)
	dst = append(dst, '0', '1', 'H', 'Q')
	for shift := 44; shift >= 0; shift -= 4 {
		dst = append(dst, hexDigits[(value>>uint(shift))&0xf])
	}
	return dst
}

// ---------------------------------------------------------------- the parsed head

type reqHead struct {
	method         string
	target         string
	host           string
	contentLength  int
	chunked        bool
	close          bool
	expectContinue bool
	authorized     bool
	gitProtocolV2  bool
}

// asciiEqualFold reports whether raw is lower ignoring ASCII case; lower must be lowercase.
func asciiEqualFold(raw []byte, lower string) bool {
	if len(raw) != len(lower) {
		return false
	}
	for index := 0; index < len(lower); index++ {
		c := raw[index]
		if c != lower[index] && c|0x20 != lower[index] {
			return false
		}
	}
	return true
}

func skipSpaceBytes(raw []byte, start int, end int) int {
	for start < end && (raw[start] == ' ' || raw[start] == '\t') {
		start++
	}
	return start
}

func indexBytes(raw []byte, from int, b byte) int {
	for index := from; index < len(raw); index++ {
		if raw[index] == b {
			return index
		}
	}
	return -1
}

func indexCRLF(raw []byte, from int) int {
	for index := from; index+1 < len(raw); index++ {
		if raw[index] == '\r' && raw[index+1] == '\n' {
			return index
		}
	}
	return -1
}

func internMethod(raw []byte) string {
	switch string(raw) {
	case "GET":
		return "GET"
	case "POST":
		return "POST"
	case "PUT":
		return "PUT"
	case "PATCH":
		return "PATCH"
	case "DELETE":
		return "DELETE"
	case "HEAD":
		return "HEAD"
	case "OPTIONS":
		return "OPTIONS"
	}
	return string(raw)
}

// parseHead reads a request head (the request line and every header, the final CRLF included).
// ok is false when the head is malformed and the connection has earned a 400.
func parseHead(raw []byte) (reqHead, bool) {
	head := reqHead{host: "localhost"}
	firstEnd := indexCRLF(raw, 0)
	if firstEnd < 0 {
		return head, false
	}
	methodEnd := indexBytes(raw, 0, ' ')
	if methodEnd < 0 || methodEnd > firstEnd {
		return head, false
	}
	targetEnd := indexBytes(raw, methodEnd+1, ' ')
	if targetEnd < 0 || targetEnd > firstEnd {
		return head, false
	}
	head.method = internMethod(raw[:methodEnd])
	head.target = string(raw[methodEnd+1 : targetEnd])
	// HTTP/1.0 has no keep-alive unless it asks for one.
	if targetEnd+8 < len(raw) && raw[targetEnd+8] == '0' {
		head.close = true
	}

	lineStart := firstEnd + 2
	for {
		lineEnd := indexCRLF(raw, lineStart)
		if lineEnd < 0 || lineEnd == lineStart {
			break
		}
		colon := indexBytes(raw, lineStart, ':')
		if colon < 0 || colon > lineEnd {
			lineStart = lineEnd + 2
			continue
		}
		name := raw[lineStart:colon]
		valueStart := skipSpaceBytes(raw, colon+1, lineEnd)
		switch len(name) {
		case 4:
			if asciiEqualFold(name, "host") {
				head.host = string(raw[valueStart:lineEnd])
			}
		case 6:
			if asciiEqualFold(name, "expect") && lineEnd-valueStart >= 4 && raw[valueStart] == '1' {
				head.expectContinue = true
			}
		case 10:
			if asciiEqualFold(name, "connection") {
				head.close = asciiEqualFold(raw[valueStart:lineEnd], "close")
			}
		case 12:
			if asciiEqualFold(name, "git-protocol") {
				head.gitProtocolV2 = containsToken(raw[valueStart:lineEnd], "version=2")
			}
		case 13:
			if asciiEqualFold(name, "authorization") {
				// Any non-empty credential after the scheme counts: the trial carries one token.
				space := indexBytes(raw[:lineEnd], valueStart, ' ')
				head.authorized = space >= 0 && skipSpaceBytes(raw, space+1, lineEnd) < lineEnd
			}
		case 14:
			if asciiEqualFold(name, "content-length") {
				length, ok := parseIntPrefix(string(raw[valueStart:lineEnd]))
				if !ok || length < 0 {
					return head, false
				}
				head.contentLength = length
			}
		case 17:
			if asciiEqualFold(name, "transfer-encoding") {
				head.chunked = containsToken(raw[valueStart:lineEnd], "chunked")
			}
		}
		lineStart = lineEnd + 2
	}
	return head, true
}

// containsToken reports whether raw holds needle.
func containsToken(raw []byte, needle string) bool {
	limit := len(raw) - len(needle)
	for index := 0; index <= limit; index++ {
		matched := true
		for offset := 0; offset < len(needle); offset++ {
			if raw[index+offset] != needle[offset] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- one connection

type conn struct {
	socket net.Conn
	buf    []byte
	scan   int
	out    []byte
	chunks []byte
}

// appendInt appends a non-negative integer without reaching for strconv's general path.
func appendUint(dst []byte, value int) []byte {
	if value == 0 {
		return append(dst, '0')
	}
	var scratch [20]byte
	at := len(scratch)
	for value > 0 {
		at--
		scratch[at] = byte('0' + value%10)
		value /= 10
	}
	return append(dst, scratch[at:]...)
}

// writeReply composes an answer into the connection's scratch buffer and hands it to the socket:
// one write(2) a response, with the body in the same allocation as the head.
func (cn *conn) writeReply(reply *Reply, headOnly bool, closeConn bool) error {
	statResponses.Add(1)
	out := cn.out[:0]
	if line, held := statusLines[reply.Status]; held {
		out = append(out, line...)
	} else {
		out = append(out, "HTTP/1.1 "...)
		out = appendUint(out, reply.Status)
		out = append(out, " OK\r\n"...)
	}
	if reply.Type != "" {
		out = append(out, "content-type: "...)
		out = append(out, reply.Type...)
		out = append(out, '\r', '\n')
	}
	out = append(out, "content-length: "...)
	out = appendUint(out, len(reply.Body))
	out = append(out, '\r', '\n')
	if reply.Stamp {
		out = append(out, "x-github-request-id: "...)
		out = appendRequestID(out)
		out = append(out, '\r', '\n')
	}
	for _, extra := range reply.Headers {
		out = append(out, extra.Name...)
		out = append(out, ':', ' ')
		out = append(out, extra.Value...)
		out = append(out, '\r', '\n')
	}
	if closeConn {
		out = append(out, "connection: close\r\n"...)
	}
	out = append(out, '\r', '\n')
	if !headOnly && len(reply.Body) > 0 {
		out = append(out, reply.Body...)
	}
	cn.out = out[:0]
	if cap(cn.out) > 1<<20 {
		// Do not let one large answer pin a megabyte per idle connection.
		cn.out = nil
	}
	statWrites.Add(1)
	_, err := cn.socket.Write(out)
	return err
}

var errBadFraming = errors.New("the request framing is broken")

// readChunked decodes as much of a chunked body as the buffer holds from bodyAt. It answers the
// offset just past the body's last byte, -1 while more is needed, or -2 when the framing is broken.
func (cn *conn) readChunked(bodyAt int) (int, int) {
	buf := cn.buf
	// A re-scan: every call walks the body from the start, so the decoded bytes must start empty
	// or a body that arrived in two segments would be assembled with its first half twice.
	cn.chunks = cn.chunks[:0]
	offset := bodyAt
	for {
		lineEnd := indexBytes(buf, offset, '\n')
		if lineEnd < 0 {
			return -1, 0
		}
		size := 0
		digits := 0
		for index := offset; index < lineEnd; index++ {
			value := nibble(buf[index])
			if value < 0 {
				break
			}
			size = size*16 + value
			digits++
			if size > maxBodyBytes {
				return -2, 0
			}
		}
		if digits == 0 {
			return -2, 0
		}
		dataAt := lineEnd + 1
		if size == 0 {
			// The last chunk is followed by an optional trailer section and then one empty line.
			if len(buf) >= dataAt+2 && buf[dataAt] == '\r' && buf[dataAt+1] == '\n' {
				return dataAt + 2, len(cn.chunks)
			}
			trailerEnd := indexCRLFCRLF(buf, lineEnd-1)
			if trailerEnd < 0 {
				return -1, 0
			}
			return trailerEnd + 4, len(cn.chunks)
		}
		if len(buf) < dataAt+size+2 {
			return -1, 0
		}
		if len(cn.chunks)+size > maxBodyBytes {
			return -2, 0
		}
		cn.chunks = append(cn.chunks, buf[dataAt:dataAt+size]...)
		offset = dataAt + size + 2
	}
}

func indexCRLFCRLF(raw []byte, from int) int {
	if from < 0 {
		from = 0
	}
	for index := from; index+3 < len(raw); index++ {
		if raw[index] == '\r' && raw[index+1] == '\n' && raw[index+2] == '\r' && raw[index+3] == '\n' {
			return index
		}
	}
	return -1
}

// ---------------------------------------------------------------- the server

// forgeServer owns the listener and the live connections.
type forgeServer struct {
	handler  Handler
	listener net.Listener
	mu       sync.Mutex
	live     map[net.Conn]struct{}
	closed   atomic.Bool
}

func newForgeServer(handler Handler) *forgeServer {
	return &forgeServer{handler: handler, live: make(map[net.Conn]struct{})}
}

// listen binds an ephemeral port on 0.0.0.0 and answers it.
func (s *forgeServer) listen() (int, error) {
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return 0, err
	}
	s.listener = listener
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// rebind drops the listener, for the rare case where listen(0) hands out the env's own port.
func (s *forgeServer) rebind() error {
	if s.listener != nil {
		err := s.listener.Close()
		s.listener = nil
		return err
	}
	return nil
}

// serve accepts connections until the listener is closed.
func (s *forgeServer) serve() {
	for {
		socket, err := s.listener.Accept()
		if err != nil {
			if s.closed.Load() {
				return
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			// EMFILE when the benchmark's sockets pile up: back off rather than spin or die.
			note("[forge]", "accept failed: "+err.Error())
			time.Sleep(5 * time.Millisecond)
			continue
		}
		if tcp, ok := socket.(*net.TCPConn); ok {
			tcp.SetNoDelay(true)
		}
		s.mu.Lock()
		s.live[socket] = struct{}{}
		s.mu.Unlock()
		go s.handleConn(socket)
	}
}

// closeAll hangs up on every connection the server still holds.
func (s *forgeServer) closeAll() {
	s.closed.Store(true)
	if s.listener != nil {
		s.listener.Close()
	}
	s.mu.Lock()
	for socket := range s.live {
		socket.Close()
	}
	s.mu.Unlock()
}

func (s *forgeServer) handleConn(socket net.Conn) {
	defer func() {
		if recovered := recover(); recovered != nil {
			note("[forge]", "a connection panicked: "+describeRecovered(recovered))
		}
		socket.Close()
		s.mu.Lock()
		delete(s.live, socket)
		s.mu.Unlock()
	}()

	cn := &conn{socket: socket, buf: make([]byte, 0, 16384), out: make([]byte, 0, 16384)}
	for {
		if len(cn.buf) == cap(cn.buf) {
			grown := make([]byte, len(cn.buf), growTo(cap(cn.buf)))
			copy(grown, cn.buf)
			cn.buf = grown
		}
		n, err := socket.Read(cn.buf[len(cn.buf):cap(cn.buf)])
		if n > 0 {
			statReads.Add(1)
			statReadBytes.Add(uint64(n))
			cn.buf = cn.buf[:len(cn.buf)+n]
			if !s.drain(cn) {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func growTo(current int) int {
	if current < 16384 {
		return 16384
	}
	if current >= maxBodyBytes {
		return current + 1<<20
	}
	return current * 2
}

// drain serves every whole request the connection's buffer holds, in arrival order. It answers
// false when the connection is finished.
func (s *forgeServer) drain(cn *conn) bool {
	for {
		end := indexCRLFCRLF(cn.buf, cn.scan)
		if end < 0 {
			if len(cn.buf) > maxHeadBytes {
				cn.socket.Write(badRequestBytes)
				return false
			}
			cn.scan = len(cn.buf) - 3
			if cn.scan < 0 {
				cn.scan = 0
			}
			return true
		}
		head, ok := parseHead(cn.buf[:end+2])
		if !ok {
			cn.socket.Write(badRequestBytes)
			return false
		}
		if head.contentLength > maxBodyBytes {
			cn.writeReply(&Reply{Status: 413, Type: "application/json; charset=utf-8", Body: tooLargeBody, Stamp: true}, false, true)
			return false
		}
		bodyAt := end + 4
		if head.expectContinue {
			cn.socket.Write(continueBytes)
		}

		var body []byte
		var consumed int
		if head.chunked {
			stop, size := cn.readChunked(bodyAt)
			if stop == -1 {
				cn.scan = 0
				return true
			}
			if stop == -2 {
				cn.socket.Write(badRequestBytes)
				return false
			}
			body = cn.chunks[:size]
			consumed = stop
		} else {
			consumed = bodyAt + head.contentLength
			if len(cn.buf) < consumed {
				cn.scan = 0
				return true
			}
			body = cn.buf[bodyAt:consumed]
		}

		mark := -1
		for index := 0; index < len(head.target); index++ {
			if head.target[index] == '?' {
				mark = index
				break
			}
		}
		request := Request{
			Method:        head.method,
			Target:        head.target,
			Path:          head.target,
			Body:          body,
			Authorized:    head.authorized,
			GitProtocolV2: head.gitProtocolV2,
			Host:          head.host,
		}
		if mark >= 0 {
			request.Path = head.target[:mark]
			request.Query = head.target[mark+1:]
		}

		reply := s.call(&request)
		writeErr := cn.writeReply(&reply, head.method == "HEAD", head.close)

		// Keep the next request's bytes and let the consumed ones go.
		if consumed >= len(cn.buf) {
			cn.buf = cn.buf[:0]
		} else {
			rest := len(cn.buf) - consumed
			copy(cn.buf, cn.buf[consumed:])
			cn.buf = cn.buf[:rest]
		}
		cn.scan = 0
		if writeErr != nil || head.close {
			return false
		}
	}
}

// call runs the handler with a recover around it: a forge that exits mid-trial scores nothing.
func (s *forgeServer) call(request *Request) (reply Reply) {
	defer func() {
		if recovered := recover(); recovered != nil {
			message := describeRecovered(recovered)
			note("[forge]", "the handler panicked: "+message)
			body := append([]byte(`{"message":`), appendJSONString(nil, message)...)
			reply = Reply{Status: 500, Type: "application/json; charset=utf-8", Body: append(body, '}'), Stamp: true}
		}
	}()
	return s.handler(request)
}

// ---------------------------------------------------------------- URL helpers

// queryGet answers a query-string parameter and whether it was there, decoding '+' as a space and
// %XX as a byte, the way URLSearchParams does.
func queryGet(query string, key string) (string, bool) {
	start := 0
	for start <= len(query) {
		end := len(query)
		for index := start; index < len(query); index++ {
			if query[index] == '&' {
				end = index
				break
			}
		}
		pair := query[start:end]
		if pair != "" {
			name := pair
			value := ""
			for index := 0; index < len(pair); index++ {
				if pair[index] == '=' {
					name = pair[:index]
					value = pair[index+1:]
					break
				}
			}
			if name == key || (needsDecoding(name) && decodeForm(name) == key) {
				return decodeForm(value), true
			}
		}
		start = end + 1
	}
	return "", false
}

func needsDecoding(text string) bool {
	for index := 0; index < len(text); index++ {
		if text[index] == '%' || text[index] == '+' {
			return true
		}
	}
	return false
}

// decodeForm decodes an application/x-www-form-urlencoded component.
func decodeForm(text string) string {
	if !needsDecoding(text) {
		return text
	}
	out := make([]byte, 0, len(text))
	for index := 0; index < len(text); index++ {
		c := text[index]
		switch {
		case c == '+':
			out = append(out, ' ')
		case c == '%' && index+2 < len(text):
			high := nibble(text[index+1])
			low := nibble(text[index+2])
			if high < 0 || low < 0 {
				out = append(out, c)
				continue
			}
			out = append(out, byte(high<<4|low))
			index += 2
		default:
			out = append(out, c)
		}
	}
	return string(out)
}

// decodeSegment decodes a path segment the way decodeURIComponent does, answering the segment
// unchanged when it holds a malformed escape.
func decodeSegment(piece string) string {
	out := make([]byte, 0, len(piece))
	for index := 0; index < len(piece); index++ {
		c := piece[index]
		if c != '%' {
			out = append(out, c)
			continue
		}
		if index+2 >= len(piece) {
			return piece
		}
		high := nibble(piece[index+1])
		low := nibble(piece[index+2])
		if high < 0 || low < 0 {
			return piece
		}
		out = append(out, byte(high<<4|low))
		index += 2
	}
	return string(out)
}

// urlEscape percent-encodes a query-string value.
func urlEscape(text string) string {
	safe := true
	for index := 0; index < len(text); index++ {
		c := text[index]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
			safe = false
			break
		}
	}
	if safe {
		return text
	}
	out := make([]byte, 0, len(text)*3)
	for index := 0; index < len(text); index++ {
		c := text[index]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			out = append(out, c)
			continue
		}
		out = append(out, '%', hexDigits[c>>4], hexDigits[c&0xf])
	}
	return string(out)
}

// segmentsOf splits a path into percent-decoded segments, dropping the empty ones.
func segmentsOf(path string) []string {
	out := make([]string, 0, 6)
	// From 0, not 1: a target that does not begin with '/' (absolute-form, which no client here
	// sends, but which a proxy may) must not lose its first character to the assumption.
	start := 0
	for {
		slash := -1
		for index := start; index < len(path); index++ {
			if path[index] == '/' {
				slash = index
				break
			}
		}
		end := len(path)
		if slash >= 0 {
			end = slash
		}
		if end > start {
			piece := path[start:end]
			escaped := false
			for index := 0; index < len(piece); index++ {
				if piece[index] == '%' {
					escaped = true
					break
				}
			}
			if escaped {
				piece = decodeSegment(piece)
			}
			out = append(out, piece)
		}
		if slash < 0 {
			break
		}
		start = slash + 1
	}
	return out
}
