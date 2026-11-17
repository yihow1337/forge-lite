// JSON, both ways.
//
// Out: every body this forge sends is appended straight into a byte slice. JSON.stringify's
// escaping rules are reproduced exactly -- quote, backslash and the C0 controls, nothing else --
// so a title carrying '<' or '&' travels as itself rather than as an escape, which is what the
// Node forge sent and what GitHub sends.
//
// In: request bodies go through encoding/json into an `any` tree, and the small accessors below
// read it with the same tolerance the TypeScript had (a field of the wrong type is simply absent).

package main

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
)

const hexUpper = "0123456789abcdef"

// appendJSONString appends s as a quoted JSON string.
func appendJSONString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for index := 0; index < len(s); index++ {
		c := s[index]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		dst = append(dst, s[start:index]...)
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hexUpper[c>>4], hexUpper[c&0xf])
		}
		start = index + 1
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}

// jsonQuote answers s as a quoted JSON string.
func jsonQuote(s string) string {
	return string(appendJSONString(make([]byte, 0, len(s)+2), s))
}

// jb builds one JSON body. It tracks whether a comma is owed, so the callers read as a list of
// fields rather than as string concatenation with separators.
type jb struct {
	buf   []byte
	comma bool
}

func (b *jb) openObject() {
	b.buf = append(b.buf, '{')
	b.comma = false
}

func (b *jb) closeObject() {
	b.buf = append(b.buf, '}')
	b.comma = true
}

func (b *jb) openArray() {
	b.buf = append(b.buf, '[')
	b.comma = false
}

func (b *jb) closeArray() {
	b.buf = append(b.buf, ']')
	b.comma = true
}

// sep writes the comma an element owes its predecessor.
func (b *jb) sep() {
	if b.comma {
		b.buf = append(b.buf, ',')
	}
	b.comma = true
}

// key starts a field.
func (b *jb) key(name string) {
	b.sep()
	b.buf = appendJSONString(b.buf, name)
	b.buf = append(b.buf, ':')
	b.comma = false
}

func (b *jb) str(name string, value string) {
	b.key(name)
	b.buf = appendJSONString(b.buf, value)
	b.comma = true
}

func (b *jb) num(name string, value int) {
	b.key(name)
	b.buf = strconv.AppendInt(b.buf, int64(value), 10)
	b.comma = true
}

func (b *jb) bool(name string, value bool) {
	b.key(name)
	if value {
		b.buf = append(b.buf, "true"...)
	} else {
		b.buf = append(b.buf, "false"...)
	}
	b.comma = true
}

func (b *jb) null(name string) {
	b.key(name)
	b.buf = append(b.buf, "null"...)
	b.comma = true
}

// strOrNull writes a string field, or null when present is false.
func (b *jb) strOrNull(name string, value string, present bool) {
	if present {
		b.str(name, value)
	} else {
		b.null(name)
	}
}

// raw writes a field whose value is already JSON.
func (b *jb) raw(name string, value []byte) {
	b.key(name)
	b.buf = append(b.buf, value...)
	b.comma = true
}

// obj starts a nested object field.
func (b *jb) obj(name string) {
	b.key(name)
	b.openObject()
}

// arr starts a nested array field.
func (b *jb) arr(name string) {
	b.key(name)
	b.openArray()
}

// item starts an array element.
func (b *jb) item() {
	b.sep()
	b.comma = false
}

// itemStr writes one string array element.
func (b *jb) itemStr(value string) {
	b.sep()
	b.buf = appendJSONString(b.buf, value)
	b.comma = true
}

// itemRaw writes one array element whose value is already JSON.
func (b *jb) itemRaw(value []byte) {
	b.sep()
	b.buf = append(b.buf, value...)
	b.comma = true
}

// ---------------------------------------------------------------- reading

// parseJSON reads a request body; ok is false when the bytes are not JSON.
func parseJSON(body []byte) (any, bool) {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, false
	}
	return value, true
}

// jsonObj answers value as an object, or an empty one (never nil) when it is anything else.
func jsonObj(value any) map[string]any {
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return map[string]any{}
}

// isJSONObj reports whether value is a JSON object.
func isJSONObj(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

// jsonArr answers value as an array; nil when it is anything else.
func jsonArr(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return nil
}

// isJSONArr reports whether value is a JSON array.
func isJSONArr(value any) bool {
	_, ok := value.([]any)
	return ok
}

// jstr answers a field as a string, or fallback when it is not one.
func jstr(object map[string]any, name string, fallback string) string {
	if text, ok := object[name].(string); ok {
		return text
	}
	return fallback
}

// jstrOk answers a field as a string and whether it was one.
func jstrOk(object map[string]any, name string) (string, bool) {
	text, ok := object[name].(string)
	return text, ok
}

// jboolOk answers a field as a boolean and whether it was one.
func jboolOk(object map[string]any, name string) (bool, bool) {
	value, ok := object[name].(bool)
	return value, ok
}

// jnumOk answers a field as a number and whether it was one.
func jnumOk(object map[string]any, name string) (float64, bool) {
	value, ok := object[name].(float64)
	return value, ok
}

// anyString answers a value as a string the way String(value) would for the shapes that reach it.
func anyString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return formatNumber(typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case nil:
		return ""
	}
	return ""
}

// formatNumber renders a JSON number the way JavaScript renders it.
func formatNumber(value float64) string {
	if value == float64(int64(value)) && value < 1e21 && value > -1e21 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// base64Of answers data base64-encoded, as Buffer#toString('base64') does.
func base64Of(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// base64Decode decodes base64 the way Buffer.from(text, 'base64') does: forgiving about padding
// and about the two alphabets, and stopping at the first character that belongs to neither.
func base64Decode(text string) []byte {
	cleaned := make([]byte, 0, len(text))
	for index := 0; index < len(text); index++ {
		c := text[index]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			cleaned = append(cleaned, c)
		case c == '-':
			cleaned = append(cleaned, '+')
		case c == '_':
			cleaned = append(cleaned, '/')
		}
	}
	for len(cleaned)%4 != 0 {
		cleaned = append(cleaned, '=')
	}
	out, err := base64.StdEncoding.DecodeString(string(cleaned))
	if err != nil {
		return []byte{}
	}
	return out
}
