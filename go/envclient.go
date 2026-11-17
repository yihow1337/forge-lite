// The client the lifecycle dials the env with: one keep-alive connection, HTTP/1.1, by hand.
//
// WHY NOT net/http
//   This binary is committed to the repository and the rules cap one file at 8 MiB. net/http
//   drags in crypto/tls, crypto/x509, the FIPS module and HTTP/2 -- about three megabytes for two
//   request shapes (POST /register and GET /done) against an origin the harness always builds as
//   plain http (cli/makefun.mjs serviceEndpoint: `http://env:8080` in a container,
//   `http://127.0.0.1:<port>` under the process driver). So the client is here instead, small
//   enough to read in one sitting.
//
// It owns one connection and re-dials whenever anything goes wrong, so a half-closed socket or an
// env restart costs one failed attempt rather than the trial.

package main

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

// envClient holds the one connection the lifecycle talks to the env over.
type envClient struct {
	target envTarget
	socket net.Conn
	buf    []byte
}

func newEnvClient(target envTarget) *envClient {
	return &envClient{target: target, buf: make([]byte, 0, 8192)}
}

// address is the host:port to dial, defaulting the port by scheme.
func (c *envClient) address() string {
	host := c.target.host
	if strings.LastIndexByte(host, ':') > strings.LastIndexByte(host, ']') {
		return host
	}
	if c.target.scheme == "https" {
		return host + ":443"
	}
	return host + ":80"
}

func (c *envClient) drop() {
	if c.socket != nil {
		c.socket.Close()
		c.socket = nil
	}
	c.buf = c.buf[:0]
}

// do makes one request, dialling first when there is no connection to reuse.
func (c *envClient) do(method string, path string, payload string, timeout time.Duration) (answer, error) {
	for attempt := 0; attempt < 2; attempt++ {
		fresh := false
		if c.socket == nil {
			socket, err := net.DialTimeout("tcp", c.address(), timeout)
			if err != nil {
				return answer{}, err
			}
			if tcp, ok := socket.(*net.TCPConn); ok {
				tcp.SetNoDelay(true)
			}
			c.socket = socket
			c.buf = c.buf[:0]
			fresh = true
		}
		result, err := c.roundTrip(method, path, payload, timeout)
		if err == nil {
			return result, nil
		}
		c.drop()
		// A connection the env closed while it was idle fails on the first write or read; one
		// retry on a fresh socket is what keep-alive owes the caller. A failure on a socket we
		// just dialled is real.
		if fresh {
			return answer{}, err
		}
	}
	return answer{}, errors.New("the env did not answer")
}

func (c *envClient) roundTrip(method string, path string, payload string, timeout time.Duration) (answer, error) {
	deadline := time.Now().Add(timeout)
	if err := c.socket.SetDeadline(deadline); err != nil {
		return answer{}, err
	}

	head := make([]byte, 0, 256+len(payload))
	head = append(head, method...)
	head = append(head, ' ')
	if c.target.prefix != "" {
		head = append(head, c.target.prefix...)
	}
	head = append(head, path...)
	head = append(head, " HTTP/1.1\r\nhost: "...)
	head = append(head, c.target.host...)
	head = append(head, "\r\naccept: application/json\r\n"...)
	if payload != "" {
		head = append(head, "content-type: application/json\r\ncontent-length: "...)
		head = appendUint(head, len(payload))
		head = append(head, '\r', '\n')
	}
	head = append(head, '\r', '\n')
	if payload != "" {
		head = append(head, payload...)
	}
	if _, err := c.socket.Write(head); err != nil {
		return answer{}, err
	}

	// Read until the head is complete, then until the body is.
	for {
		end := indexCRLFCRLF(c.buf, 0)
		if end >= 0 {
			status, length, chunked, closeAfter, ok := parseResponseHead(c.buf[:end+2])
			if !ok {
				return answer{}, errors.New("the env answered a malformed response")
			}
			bodyAt := end + 4
			body, consumed, complete, err := c.readBody(bodyAt, length, chunked, closeAfter)
			if err != nil {
				return answer{}, err
			}
			if complete {
				result := answer{status: status, body: body}
				if closeAfter {
					c.drop()
				} else if consumed >= len(c.buf) {
					c.buf = c.buf[:0]
				} else {
					rest := len(c.buf) - consumed
					copy(c.buf, c.buf[consumed:])
					c.buf = c.buf[:rest]
				}
				return result, nil
			}
		}
		if len(c.buf) > 1<<20 {
			return answer{}, errors.New("the env answered more than a megabyte")
		}
		if len(c.buf) == cap(c.buf) {
			grown := make([]byte, len(c.buf), cap(c.buf)*2)
			copy(grown, c.buf)
			c.buf = grown
		}
		n, err := c.socket.Read(c.buf[len(c.buf):cap(c.buf)])
		c.buf = c.buf[:len(c.buf)+n]
		if err != nil {
			if n > 0 {
				continue
			}
			// A body with neither a length nor chunking ends at EOF.
			if end := indexCRLFCRLF(c.buf, 0); end >= 0 {
				status, length, chunked, _, ok := parseResponseHead(c.buf[:end+2])
				if ok && length < 0 && !chunked {
					body := string(c.buf[end+4:])
					c.drop()
					return answer{status: status, body: body}, nil
				}
			}
			return answer{}, err
		}
	}
}

// readBody answers the body the buffer already holds, how many bytes it took, and whether it is
// complete.
func (c *envClient) readBody(bodyAt int, length int, chunked bool, closeAfter bool) (string, int, bool, error) {
	if chunked {
		offset := bodyAt
		var body []byte
		for {
			lineEnd := indexBytes(c.buf, offset, '\n')
			if lineEnd < 0 {
				return "", 0, false, nil
			}
			size := 0
			digits := 0
			for index := offset; index < lineEnd; index++ {
				value := nibble(c.buf[index])
				if value < 0 {
					break
				}
				size = size*16 + value
				digits++
				if size > 1<<20 {
					return "", 0, false, errors.New("the env answered an oversized chunk")
				}
			}
			if digits == 0 {
				return "", 0, false, errors.New("the env answered a malformed chunk")
			}
			dataAt := lineEnd + 1
			if size == 0 {
				trailerEnd := indexCRLFCRLF(c.buf, lineEnd-1)
				if len(c.buf) >= dataAt+2 && c.buf[dataAt] == '\r' && c.buf[dataAt+1] == '\n' {
					return string(body), dataAt + 2, true, nil
				}
				if trailerEnd < 0 {
					return "", 0, false, nil
				}
				return string(body), trailerEnd + 4, true, nil
			}
			if len(c.buf) < dataAt+size+2 {
				return "", 0, false, nil
			}
			body = append(body, c.buf[dataAt:dataAt+size]...)
			offset = dataAt + size + 2
		}
	}
	if length >= 0 {
		if len(c.buf) < bodyAt+length {
			return "", 0, false, nil
		}
		return string(c.buf[bodyAt : bodyAt+length]), bodyAt + length, true, nil
	}
	// Neither a length nor chunking: the body runs to EOF, which the read loop handles.
	return "", 0, false, nil
}

// parseResponseHead reads a status line and the headers the client cares about. A length of -1
// means no Content-Length was sent.
func parseResponseHead(raw []byte) (status int, length int, chunked bool, closeAfter bool, ok bool) {
	length = -1
	firstEnd := indexCRLF(raw, 0)
	if firstEnd < 0 {
		return 0, 0, false, false, false
	}
	space := indexBytes(raw[:firstEnd], 0, ' ')
	if space < 0 {
		return 0, 0, false, false, false
	}
	codeEnd := space + 1
	for codeEnd < firstEnd && raw[codeEnd] >= '0' && raw[codeEnd] <= '9' {
		codeEnd++
	}
	parsed, err := strconv.Atoi(string(raw[space+1 : codeEnd]))
	if err != nil {
		return 0, 0, false, false, false
	}
	status = parsed
	if firstEnd >= 8 && raw[7] == '0' {
		closeAfter = true
	}

	lineStart := firstEnd + 2
	for {
		lineEnd := indexCRLF(raw, lineStart)
		if lineEnd < 0 || lineEnd == lineStart {
			break
		}
		colon := indexBytes(raw[:lineEnd], lineStart, ':')
		if colon < 0 {
			lineStart = lineEnd + 2
			continue
		}
		name := raw[lineStart:colon]
		valueStart := skipSpaceBytes(raw, colon+1, lineEnd)
		switch len(name) {
		case 10:
			if asciiEqualFold(name, "connection") {
				closeAfter = asciiEqualFold(raw[valueStart:lineEnd], "close")
			}
		case 14:
			if asciiEqualFold(name, "content-length") {
				if value, held := parseIntPrefix(string(raw[valueStart:lineEnd])); held && value >= 0 {
					length = value
				}
			}
		case 17:
			if asciiEqualFold(name, "transfer-encoding") {
				chunked = containsToken(raw[valueStart:lineEnd], "chunked")
			}
		}
		lineStart = lineEnd + 2
	}
	// A 204 and a 304 never carry a body.
	if status == 204 || status == 304 {
		length = 0
		chunked = false
	}
	return status, length, chunked, closeAfter, true
}
