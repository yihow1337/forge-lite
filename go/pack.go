// The wire formats git's smart HTTP carries: pkt-lines, and packfiles in both directions.
//
// A port of src/git/pack.ts. Everything appends into a caller-owned byte slice rather than
// building a buffer per line, and the pack reader keeps one zlib engine alive across the objects
// of a pack instead of constructing one per object (which is the one thing the Node port could
// not do, because node:zlib closes its binding at the end of a stream).

package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
)

// pktLineMax is git's LARGE_PACKET_MAX, including the four length bytes.
const pktLineMax = 65520

// sidebandChunk is the payload size a packfile section is framed at (the band byte included).
const sidebandChunk = 65515

// maxObjectBytes is the most bytes one object a client pushes may inflate or expand to. A packed
// object declares its own size -- a delta names its target size in a varint, a zlib stream names
// nothing at all -- so an unbounded reader lets a few hundred bytes on the wire ask for gigabytes
// of heap. Nothing the suite pushes comes near this.
const maxObjectBytes = 64 * 1024 * 1024

const flushText = "0000"
const delimText = "0001"

var hexDigits = "0123456789abcdef"

// appendPktLength appends the four hex length bytes of a pkt-line carrying n payload bytes.
func appendPktLength(dst []byte, n int) []byte {
	total := n + 4
	return append(dst, hexDigits[(total>>12)&0xf], hexDigits[(total>>8)&0xf], hexDigits[(total>>4)&0xf], hexDigits[total&0xf])
}

// appendPktText appends one pkt-line carrying payload.
func appendPktText(dst []byte, payload string) []byte {
	dst = appendPktLength(dst, len(payload))
	return append(dst, payload...)
}

// appendPkt appends one pkt-line carrying the bytes payload.
func appendPkt(dst []byte, payload []byte) []byte {
	dst = appendPktLength(dst, len(payload))
	return append(dst, payload...)
}

// appendSidebandText appends payload framed as a single band-1 sideband packet.
func appendSidebandText(dst []byte, payload string) []byte {
	dst = appendPktLength(dst, len(payload)+1)
	dst = append(dst, 1)
	return append(dst, payload...)
}

// appendSidebandChunks appends data split into band-1 packets of at most sidebandChunk bytes.
func appendSidebandChunks(dst []byte, data []byte) []byte {
	for offset := 0; offset < len(data); offset += sidebandChunk {
		end := offset + sidebandChunk
		if end > len(data) {
			end = len(data)
		}
		dst = appendPktLength(dst, end-offset+1)
		dst = append(dst, 1)
		dst = append(dst, data[offset:end]...)
	}
	return dst
}

// One decoded packet's kind.
const (
	pktData = iota
	pktFlush
	pktDelim
	pktResponseEnd
)

// Packet is one decoded pkt-line: a payload, or one of the three control packets.
type Packet struct {
	Kind    int
	Payload []byte
}

// nibble answers one hex digit's value, or -1.
func nibble(code byte) int {
	switch {
	case code >= '0' && code <= '9':
		return int(code - '0')
	case code >= 'a' && code <= 'f':
		return int(code-'a') + 10
	case code >= 'A' && code <= 'F':
		return int(code-'A') + 10
	}
	return -1
}

// pktHeader answers the four hex bytes at offset as a number, or -1 when any is not a hex digit.
func pktHeader(buf []byte, offset int) int {
	a := nibble(buf[offset])
	b := nibble(buf[offset+1])
	c := nibble(buf[offset+2])
	d := nibble(buf[offset+3])
	if a < 0 || b < 0 || c < 0 || d < 0 {
		return -1
	}
	return a<<12 | b<<8 | c<<4 | d
}

// decodePktLines decodes pkt-lines until stopAtFlush or the buffer ends, answering the packets and
// the offset just past the last packet consumed (where a pack's raw bytes begin).
func decodePktLines(buf []byte, start int, stopAtFlush bool) ([]Packet, int, error) {
	packets := make([]Packet, 0, 16)
	offset := start
	for offset+4 <= len(buf) {
		length := pktHeader(buf, offset)
		if length < 0 {
			return nil, 0, fmt.Errorf("invalid pkt-line length %q", string(buf[offset:offset+4]))
		}
		if length == 0 {
			offset += 4
			packets = append(packets, Packet{Kind: pktFlush})
			if stopAtFlush {
				break
			}
			continue
		}
		if length == 1 {
			offset += 4
			packets = append(packets, Packet{Kind: pktDelim})
			continue
		}
		if length == 2 {
			offset += 4
			packets = append(packets, Packet{Kind: pktResponseEnd})
			continue
		}
		if length < 4 || offset+length > len(buf) {
			return nil, 0, fmt.Errorf("truncated pkt-line of %d bytes", length)
		}
		packets = append(packets, Packet{Kind: pktData, Payload: buf[offset+4 : offset+length]})
		offset += length
	}
	return packets, offset, nil
}

// ---------------------------------------------------------------- pack writing

// appendPackObjectHeader appends a packed object's type-and-size header.
func appendPackObjectHeader(dst []byte, typ int, size int) []byte {
	remaining := size
	current := byte(typ<<4) | byte(remaining&0x0f)
	remaining >>= 4
	for remaining > 0 {
		dst = append(dst, current|0x80)
		current = byte(remaining & 0x7f)
		remaining >>= 7
	}
	return append(dst, current)
}

// deflaters hands out zlib writers so a pack build does not construct one per object.
var deflaters = sync.Pool{
	New: func() any {
		writer, _ := zlib.NewWriterLevel(io.Discard, zlib.BestSpeed)
		return writer
	},
}

// writePack builds a packfile (version 2, no deltas) from objects, with its SHA-1 trailer.
func writePack(objects []*GitObject) []byte {
	size := 32
	for _, object := range objects {
		size += len(object.Data)/2 + 32
	}
	out := make([]byte, 0, size)
	out = append(out, 'P', 'A', 'C', 'K', 0, 0, 0, 2, 0, 0, 0, 0)
	binary.BigEndian.PutUint32(out[8:12], uint32(len(objects)))

	writer := deflaters.Get().(*zlib.Writer)
	sink := &sliceSink{out: out}
	for _, object := range objects {
		sink.out = appendPackObjectHeader(sink.out, object.Type, len(object.Data))
		writer.Reset(sink)
		writer.Write(object.Data)
		writer.Close()
	}
	deflaters.Put(writer)
	out = sink.out

	sum := sha1.Sum(out)
	return append(out, sum[:]...)
}

// sliceSink lets a zlib writer append straight into the pack buffer.
type sliceSink struct{ out []byte }

func (s *sliceSink) Write(p []byte) (int, error) {
	s.out = append(s.out, p...)
	return len(p), nil
}

// ---------------------------------------------------------------- pack reading

// inflater keeps one zlib engine alive across the objects of a pack.
type inflater struct {
	reader io.ReadCloser
	source *bytes.Reader
}

var errObjectTooLarge = errors.New("a packed object is past the object size limit")

// inflate decompresses one zlib stream at the front of src, answering the bytes and how many
// input bytes the stream took. hint is the size the pack declared, used only to size the buffer.
func (inf *inflater) inflate(src []byte, hint int) ([]byte, int, error) {
	if inf.source == nil {
		inf.source = bytes.NewReader(src)
	} else {
		inf.source.Reset(src)
	}
	if inf.reader == nil {
		reader, err := zlib.NewReader(inf.source)
		if err != nil {
			return nil, 0, err
		}
		inf.reader = reader
	} else if err := inf.reader.(zlib.Resetter).Reset(inf.source, nil); err != nil {
		return nil, 0, err
	}

	capacity := hint
	if capacity < 64 {
		capacity = 64
	}
	if capacity > maxObjectBytes {
		return nil, 0, errObjectTooLarge
	}
	out := make([]byte, 0, capacity+1)
	idle := 0
	for {
		if len(out) == cap(out) {
			if len(out) >= maxObjectBytes {
				return nil, 0, errObjectTooLarge
			}
			grown := make([]byte, len(out), cap(out)*2)
			copy(grown, out)
			out = grown
		}
		n, err := inf.reader.Read(out[len(out):cap(out)])
		out = out[:len(out)+n]
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, err
		}
		if n == 0 {
			idle++
			if idle > 64 {
				return nil, 0, errors.New("the zlib stream stalled")
			}
		} else {
			idle = 0
		}
	}
	return out, len(src) - inf.source.Len(), nil
}

// readSizeHeader reads a packed object's type-and-size header.
func readSizeHeader(buf []byte, start int) (size int, next int, first byte, err error) {
	if start >= len(buf) {
		return 0, 0, 0, io.ErrUnexpectedEOF
	}
	b := buf[start]
	first = b
	size = int(b & 0x0f)
	shift := uint(4)
	offset := start + 1
	for b&0x80 != 0 {
		if offset >= len(buf) {
			return 0, 0, 0, io.ErrUnexpectedEOF
		}
		b = buf[offset]
		offset++
		if shift < 56 {
			size += int(b&0x7f) << shift
		}
		shift += 7
		if size < 0 || size > maxObjectBytes {
			return 0, 0, 0, errObjectTooLarge
		}
	}
	return size, offset, first, nil
}

// readOfsBase reads an ofs-delta's negative base offset.
func readOfsBase(buf []byte, start int) (delta int, next int, err error) {
	if start >= len(buf) {
		return 0, 0, io.ErrUnexpectedEOF
	}
	b := buf[start]
	offset := start + 1
	value := int(b & 0x7f)
	for b&0x80 != 0 {
		if offset >= len(buf) {
			return 0, 0, io.ErrUnexpectedEOF
		}
		b = buf[offset]
		offset++
		value = (value+1)<<7 + int(b&0x7f)
		if value < 0 || value > len(buf) {
			return 0, 0, errors.New("an ofs-delta names a base outside the pack")
		}
	}
	return value, offset, nil
}

// applyDelta applies a git delta instruction stream to a base object's bytes.
func applyDelta(base []byte, delta []byte) ([]byte, error) {
	offset := 0
	readVarint := func() (int, error) {
		value := 0
		shift := uint(0)
		for {
			if offset >= len(delta) {
				return 0, io.ErrUnexpectedEOF
			}
			b := delta[offset]
			offset++
			if shift < 56 {
				value += int(b&0x7f) << shift
			}
			shift += 7
			if b&0x80 == 0 {
				break
			}
			if value < 0 || value > maxObjectBytes {
				return 0, errObjectTooLarge
			}
		}
		return value, nil
	}
	if _, err := readVarint(); err != nil {
		return nil, err
	}
	targetSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	if targetSize < 0 || targetSize > maxObjectBytes {
		return nil, errObjectTooLarge
	}
	out := make([]byte, targetSize)
	written := 0
	for offset < len(delta) {
		op := delta[offset]
		offset++
		if op&0x80 != 0 {
			copyOffset := 0
			copySize := 0
			shift := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if offset >= len(delta) {
						return nil, io.ErrUnexpectedEOF
					}
					copyOffset += int(delta[offset]) << shift
					offset++
				}
				shift += 8
			}
			shift = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if offset >= len(delta) {
						return nil, io.ErrUnexpectedEOF
					}
					copySize += int(delta[offset]) << shift
					offset++
				}
				shift += 8
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			if copyOffset < 0 || copySize < 0 || copyOffset+copySize > len(base) || written+copySize > targetSize {
				return nil, errors.New("a delta copies outside its base")
			}
			copy(out[written:], base[copyOffset:copyOffset+copySize])
			written += copySize
		} else if op != 0 {
			size := int(op)
			if offset+size > len(delta) || written+size > targetSize {
				return nil, errors.New("a delta insert runs past its stream")
			}
			copy(out[written:], delta[offset:offset+size])
			offset += size
			written += size
		} else {
			return nil, errors.New("delta opcode 0 is invalid")
		}
	}
	if written != targetSize {
		return nil, fmt.Errorf("delta produced %d of %d bytes", written, targetSize)
	}
	return out, nil
}

// rawEntry is one entry of a pack as it was read, before deltas are resolved.
type rawEntry struct {
	offset     int
	typeCode   int
	data       []byte
	baseOffset int
	baseOid    string
	oid        string
	typ        int
	resolved   []byte
	done       bool
}

// packObject is one object a pack carried, with the id it hashes to.
type packObject struct {
	OID    string
	Object *GitObject
}

// readPack reads a packfile, resolving OFS_DELTA and REF_DELTA entries (a thin pack's base may
// come from existing), and answers every object it carries, in pack order.
func readPack(pack []byte, existing ObjectStore) ([]packObject, error) {
	if len(pack) == 0 {
		return nil, nil
	}
	if len(pack) < 32 {
		return nil, fmt.Errorf("a pack of %d bytes is too short", len(pack))
	}
	if pack[0] != 'P' || pack[1] != 'A' || pack[2] != 'C' || pack[3] != 'K' {
		return nil, errors.New("the pack does not start with PACK")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	body := pack[:len(pack)-20]
	// The header's count is four client-supplied bytes. Every entry costs at least a header byte
	// and a zlib stream, so a count past the body's length describes a pack that cannot exist.
	if count < 0 || count > len(body) {
		return nil, fmt.Errorf("a pack of %d bytes claims %d objects", len(body), count)
	}

	raw := make([]rawEntry, 0, count)
	byOffset := make(map[int]int, count)
	deltas := false
	offset := 12
	inf := &inflater{}
	for index := 0; index < count; index++ {
		entryOffset := offset
		size, next, first, err := readSizeHeader(body, offset)
		if err != nil {
			return nil, err
		}
		offset = next
		typeCode := int(first>>4) & 0x07
		entry := rawEntry{offset: entryOffset, typeCode: typeCode, baseOffset: -1}
		switch typeCode {
		case 6:
			delta, next, err := readOfsBase(body, offset)
			if err != nil {
				return nil, err
			}
			offset = next
			entry.baseOffset = entryOffset - delta
			deltas = true
		case 7:
			if offset+20 > len(body) {
				return nil, io.ErrUnexpectedEOF
			}
			entry.baseOid = hex.EncodeToString(body[offset : offset+20])
			offset += 20
			deltas = true
		case objCommit, objTree, objBlob, objTag:
		default:
			return nil, fmt.Errorf("pack entry %d has type code %d", index, typeCode)
		}
		if offset > len(body) {
			return nil, io.ErrUnexpectedEOF
		}
		data, consumed, err := inf.inflate(body[offset:], size)
		if err != nil {
			return nil, err
		}
		entry.data = data
		offset += consumed
		byOffset[entryOffset] = len(raw)
		raw = append(raw, entry)
	}

	out := make([]packObject, 0, len(raw))

	// A pack with no delta entries -- which is every pack the suite pushes, and every pack git
	// sends with thin-pack off -- needs none of the resolution bookkeeping below.
	if !deltas {
		for index := range raw {
			entry := &raw[index]
			out = append(out, packObject{
				OID:    hashObject(entry.typeCode, entry.data),
				Object: &GitObject{Type: entry.typeCode, Data: entry.data},
			})
		}
		return out, nil
	}

	byOid := make(map[string]int, len(raw))
	var resolve func(index int, depth int) (int, []byte, error)
	resolve = func(index int, depth int) (int, []byte, error) {
		entry := &raw[index]
		if entry.done {
			return entry.typ, entry.resolved, nil
		}
		if depth > 64 {
			return 0, nil, errors.New("a delta chain is too deep")
		}
		var typ int
		var data []byte
		switch entry.typeCode {
		case 6:
			baseIndex, held := byOffset[entry.baseOffset]
			if !held {
				return 0, nil, errors.New("an ofs-delta names a base outside the pack")
			}
			baseType, baseData, err := resolve(baseIndex, depth+1)
			if err != nil {
				return 0, nil, err
			}
			typ = baseType
			data, err = applyDelta(baseData, entry.data)
			if err != nil {
				return 0, nil, err
			}
		case 7:
			var baseType int
			var baseData []byte
			if baseIndex, held := byOid[entry.baseOid]; held {
				var err error
				baseType, baseData, err = resolve(baseIndex, depth+1)
				if err != nil {
					return 0, nil, err
				}
			} else if object := existing[entry.baseOid]; object != nil {
				baseType, baseData = object.Type, object.Data
			} else {
				return 0, nil, fmt.Errorf("a ref-delta names the missing base %s", entry.baseOid)
			}
			typ = baseType
			var err error
			data, err = applyDelta(baseData, entry.data)
			if err != nil {
				return 0, nil, err
			}
		default:
			typ = entry.typeCode
			data = entry.data
		}
		entry.typ = typ
		entry.resolved = data
		entry.done = true
		entry.oid = hashObject(typ, data)
		byOid[entry.oid] = index
		return typ, data, nil
	}

	for index := range raw {
		typ, data, err := resolve(index, 0)
		if err != nil {
			return nil, err
		}
		out = append(out, packObject{OID: raw[index].oid, Object: &GitObject{Type: typ, Data: data}})
	}
	return out, nil
}
