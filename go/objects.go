// The git object model: ids, the four object types, and the tree surgery the contents and merge
// APIs need. Everything here is pure: a repository's object map goes in, bytes and ids come out.
//
// This is a port of src/git/objects.ts. Where the TypeScript leans on a JS Set or Map keeping its
// insertion order, the Go here carries the order explicitly (oidSet, sorted walks), so a packfile
// built from the same repository has the same bytes on every run.

package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"sort"
	"strconv"
)

// The four object types, numbered as a packfile numbers them.
const (
	objCommit = 1
	objTree   = 2
	objBlob   = 3
	objTag    = 4
)

var objTypeName = [5]string{"", "commit", "tree", "blob", "tag"}

// GitObject is one stored object: its type and its uncompressed bytes.
type GitObject struct {
	Type int
	Data []byte
}

// ObjectStore maps an object id to the object: one repository's loose store.
type ObjectStore map[string]*GitObject

// zeroOID is the all-zero id: an unborn ref's value in a receive-pack command.
const zeroOID = "0000000000000000000000000000000000000000"

// emptyTreeData is the serialization of a tree with no entries.
var emptyTreeData = []byte{}

// hashObject is git's object id: SHA-1 over "<type> <size>\0" and the object's bytes.
func hashObject(typ int, data []byte) string {
	h := sha1.New()
	var scratch [32]byte
	head := append(scratch[:0], objTypeName[typ]...)
	head = append(head, ' ')
	head = strconv.AppendInt(head, int64(len(data)), 10)
	head = append(head, 0)
	h.Write(head)
	h.Write(data)
	var sum [20]byte
	h.Sum(sum[:0])
	return hex.EncodeToString(sum[:])
}

// putObject stores an object and answers its id (an id already held is left alone).
func putObject(store ObjectStore, typ int, data []byte) string {
	oid := hashObject(typ, data)
	if _, held := store[oid]; !held {
		store[oid] = &GitObject{Type: typ, Data: data}
	}
	return oid
}

// TreeEntry is one line of a tree object.
type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

// parseTree reads a tree object into its entries, in stored order.
func parseTree(data []byte) []TreeEntry {
	var entries []TreeEntry
	offset := 0
	for offset < len(data) {
		space := bytes.IndexByte(data[offset:], ' ')
		if space < 0 {
			break
		}
		space += offset
		nul := bytes.IndexByte(data[space+1:], 0)
		if nul < 0 {
			break
		}
		nul += space + 1
		if nul+21 > len(data) {
			break
		}
		entries = append(entries, TreeEntry{
			Mode: string(data[offset:space]),
			Name: string(data[space+1 : nul]),
			OID:  hex.EncodeToString(data[nul+1 : nul+21]),
		})
		offset = nul + 21
	}
	return entries
}

// treeKey is git's tree order: byte order of the name, a directory compared as if it ended in '/'.
func treeKey(entry TreeEntry) string {
	if entry.Mode == "40000" {
		return entry.Name + "/"
	}
	return entry.Name
}

// buildTree serializes tree entries, sorted the way git sorts them.
func buildTree(entries []TreeEntry) []byte {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(a, b int) bool { return treeKey(sorted[a]) < treeKey(sorted[b]) })
	out := make([]byte, 0, len(sorted)*32)
	for _, entry := range sorted {
		out = append(out, entry.Mode...)
		out = append(out, ' ')
		out = append(out, entry.Name...)
		out = append(out, 0)
		raw, err := hex.DecodeString(entry.OID)
		if err != nil || len(raw) != 20 {
			raw = make([]byte, 20)
		}
		out = append(out, raw...)
	}
	return out
}

// CommitView is a commit object's headers and message.
type CommitView struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

func splitHeaders(data []byte) (headerText string, message string) {
	blank := bytes.Index(data, []byte("\n\n"))
	if blank < 0 {
		return string(data), ""
	}
	return string(data[:blank]), string(data[blank+2:])
}

// eachHeaderLine calls fn with every "<key> <value>" header line.
func eachHeaderLine(headerText string, fn func(key, value string)) {
	for len(headerText) > 0 {
		line := headerText
		if nl := indexByteStr(headerText, '\n'); nl >= 0 {
			line = headerText[:nl]
			headerText = headerText[nl+1:]
		} else {
			headerText = ""
		}
		space := indexByteStr(line, ' ')
		if space < 0 {
			continue
		}
		fn(line[:space], line[space+1:])
	}
}

func indexByteStr(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// parseCommit reads a commit object's headers and message.
func parseCommit(data []byte) CommitView {
	headerText, message := splitHeaders(data)
	view := CommitView{Message: message}
	eachHeaderLine(headerText, func(key, value string) {
		switch key {
		case "tree":
			view.Tree = value
		case "parent":
			view.Parents = append(view.Parents, value)
		case "author":
			view.Author = value
		case "committer":
			view.Committer = value
		}
	})
	return view
}

// forgeIdentity is the identity every commit this forge makes on its own carries.
const forgeIdentity = "make.fun forge <forge@make.fun>"

// BuildCommitFields names the parts of a commit this forge writes.
type BuildCommitFields struct {
	Tree      string
	Parents   []string
	Message   string
	Author    string
	Committer string
	Timestamp int64
	Timezone  string
}

// buildCommit writes a commit object's bytes, byte-for-byte as git writes them.
func buildCommit(fields BuildCommitFields) []byte {
	timestamp := fields.Timestamp
	if timestamp == 0 {
		timestamp = epochSec
	}
	timezone := fields.Timezone
	if timezone == "" {
		timezone = "+0000"
	}
	author := fields.Author
	if author == "" {
		author = forgeIdentity
	}
	committer := fields.Committer
	if committer == "" {
		committer = author
	}
	out := make([]byte, 0, 256+len(fields.Message))
	out = append(out, "tree "...)
	out = append(out, fields.Tree...)
	out = append(out, '\n')
	for _, parent := range fields.Parents {
		out = append(out, "parent "...)
		out = append(out, parent...)
		out = append(out, '\n')
	}
	out = append(out, "author "...)
	out = append(out, author...)
	out = append(out, ' ')
	out = strconv.AppendInt(out, timestamp, 10)
	out = append(out, ' ')
	out = append(out, timezone...)
	out = append(out, '\n')
	out = append(out, "committer "...)
	out = append(out, committer...)
	out = append(out, ' ')
	out = strconv.AppendInt(out, timestamp, 10)
	out = append(out, ' ')
	out = append(out, timezone...)
	out = append(out, '\n', '\n')
	out = append(out, fields.Message...)
	if len(fields.Message) == 0 || fields.Message[len(fields.Message)-1] != '\n' {
		out = append(out, '\n')
	}
	return out
}

// TagView is an annotated tag object's headers and message.
type TagView struct {
	Object  string
	Type    string
	Tag     string
	Tagger  string
	Message string
}

func parseTag(data []byte) TagView {
	headerText, message := splitHeaders(data)
	view := TagView{Message: message}
	eachHeaderLine(headerText, func(key, value string) {
		switch key {
		case "object":
			view.Object = value
		case "type":
			view.Type = value
		case "tag":
			view.Tag = value
		case "tagger":
			view.Tagger = value
		}
	})
	return view
}

// peel follows tag objects down to the first non-tag object; "" when one is missing.
func peel(store ObjectStore, oid string) string {
	current := oid
	for hops := 0; hops < 16; hops++ {
		object := store[current]
		if object == nil {
			return ""
		}
		if object.Type != objTag {
			return current
		}
		current = parseTag(object.Data).Object
	}
	return ""
}

// isOid reports whether value is a 40-character lowercase hex id.
func isOid(value string) bool {
	if len(value) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// oidSet is a set of object ids that remembers the order they were added in, which is what keeps
// a packfile's object order the same on every run.
type oidSet struct {
	order []string
	seen  map[string]struct{}
}

func newOidSet() *oidSet {
	return &oidSet{seen: make(map[string]struct{})}
}

func (s *oidSet) add(oid string) bool {
	if _, held := s.seen[oid]; held {
		return false
	}
	s.seen[oid] = struct{}{}
	s.order = append(s.order, oid)
	return true
}

func (s *oidSet) has(oid string) bool {
	_, held := s.seen[oid]
	return held
}

func (s *oidSet) len() int { return len(s.order) }

// reachable answers every object reachable from roots. stopCommits names commits whose parents are
// not walked (a shallow boundary); a missing object ends that branch of the walk instead of failing.
func reachable(store ObjectStore, roots []string, stopCommits *oidSet) *oidSet {
	seen := newOidSet()
	queue := make([]string, 0, len(roots))
	for _, root := range roots {
		if root != zeroOID {
			queue = append(queue, root)
		}
	}
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen.has(oid) {
			continue
		}
		object := store[oid]
		if object == nil {
			continue
		}
		seen.add(oid)
		switch object.Type {
		case objCommit:
			commit := parseCommit(object.Data)
			queue = append(queue, commit.Tree)
			if stopCommits == nil || !stopCommits.has(oid) {
				queue = append(queue, commit.Parents...)
			}
		case objTag:
			queue = append(queue, parseTag(object.Data).Object)
		case objTree:
			for _, entry := range parseTree(object.Data) {
				if entry.Mode == "160000" {
					continue
				}
				queue = append(queue, entry.OID)
			}
		}
	}
	return seen
}

// commitList answers the commits reachable from roots by parent links, newest first
// (breadth-first, deduplicated).
func commitList(store ObjectStore, roots []string, limit int) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, 16)
	queue := make([]string, 0, len(roots))
	for _, root := range roots {
		if resolved := peel(store, root); resolved != "" {
			queue = append(queue, resolved)
		}
	}
	for len(queue) > 0 && len(out) < limit {
		oid := queue[0]
		queue = queue[1:]
		if _, held := seen[oid]; held {
			continue
		}
		object := store[oid]
		if object == nil || object.Type != objCommit {
			continue
		}
		seen[oid] = struct{}{}
		out = append(out, oid)
		queue = append(queue, parseCommit(object.Data).Parents...)
	}
	return out
}

// isAncestor reports whether ancestor is reachable from tip by parent links (so tip fast-forwards it).
func isAncestor(store ObjectStore, ancestor string, tip string) bool {
	target := peel(store, ancestor)
	if target == "" {
		target = ancestor
	}
	start := peel(store, tip)
	if start == "" {
		return false
	}
	if start == target {
		return true
	}
	seen := make(map[string]struct{})
	queue := []string{start}
	for len(queue) > 0 {
		oid := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if _, held := seen[oid]; held {
			continue
		}
		seen[oid] = struct{}{}
		if oid == target {
			return true
		}
		object := store[oid]
		if object == nil || object.Type != objCommit {
			continue
		}
		queue = append(queue, parseCommit(object.Data).Parents...)
	}
	return false
}

// mergeBase answers the best common ancestor of two commits, or "" when they share none.
func mergeBase(store ObjectStore, a string, b string) string {
	left := make(map[string]struct{})
	for _, oid := range commitList(store, []string{a}, 5000) {
		left[oid] = struct{}{}
	}
	for _, oid := range commitList(store, []string{b}, 5000) {
		if _, held := left[oid]; held {
			return oid
		}
	}
	return ""
}

// commitOf answers the commit a ref value points at, following tags; "" when it is not a commit.
func commitOf(store ObjectStore, oid string) string {
	resolved := peel(store, oid)
	if resolved == "" {
		return ""
	}
	if object := store[resolved]; object != nil && object.Type == objCommit {
		return resolved
	}
	return ""
}

// treeOfCommit answers the tree of a commit, or "".
func treeOfCommit(store ObjectStore, commitOid string) string {
	object := store[commitOid]
	if object == nil || object.Type != objCommit {
		return ""
	}
	return parseCommit(object.Data).Tree
}

// treeLookup answers the entry at segments under treeOid, or nil when the path is absent.
func treeLookup(store ObjectStore, treeOid string, segments []string) *TreeEntry {
	current := treeOid
	for index := 0; index < len(segments); index++ {
		object := store[current]
		if object == nil || object.Type != objTree {
			return nil
		}
		var found *TreeEntry
		for _, entry := range parseTree(object.Data) {
			if entry.Name == segments[index] {
				candidate := entry
				found = &candidate
				break
			}
		}
		if found == nil {
			return nil
		}
		if index == len(segments)-1 {
			return found
		}
		if found.Mode != "40000" {
			return nil
		}
		current = found.OID
	}
	return nil
}

// treeWithPath answers a copy of treeOid with segments set to oid (mode mode); intermediate trees
// are created. An empty treeOid stands for a tree that is not there.
func treeWithPath(store ObjectStore, treeOid string, segments []string, oid string, mode string) string {
	var entries []TreeEntry
	if treeOid != "" {
		if object := store[treeOid]; object != nil && object.Type == objTree {
			entries = parseTree(object.Data)
		}
	}
	head := segments[0]
	kept := make([]TreeEntry, 0, len(entries)+1)
	for _, entry := range entries {
		if entry.Name != head {
			kept = append(kept, entry)
		}
	}
	if len(segments) == 1 {
		kept = append(kept, TreeEntry{Mode: mode, Name: head, OID: oid})
	} else {
		existing := ""
		for _, entry := range entries {
			if entry.Name == head && entry.Mode == "40000" {
				existing = entry.OID
				break
			}
		}
		kept = append(kept, TreeEntry{Mode: "40000", Name: head, OID: treeWithPath(store, existing, segments[1:], oid, mode)})
	}
	return putObject(store, objTree, buildTree(kept))
}

// treeWithoutPath answers a copy of treeOid without segments; "" when the path was not there.
func treeWithoutPath(store ObjectStore, treeOid string, segments []string) string {
	object := store[treeOid]
	if object == nil || object.Type != objTree {
		return ""
	}
	entries := parseTree(object.Data)
	head := segments[0]
	var existing *TreeEntry
	for _, entry := range entries {
		if entry.Name == head {
			candidate := entry
			existing = &candidate
			break
		}
	}
	if existing == nil {
		return ""
	}
	kept := make([]TreeEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Name != head {
			kept = append(kept, entry)
		}
	}
	if len(segments) > 1 {
		if existing.Mode != "40000" {
			return ""
		}
		child := treeWithoutPath(store, existing.OID, segments[1:])
		if child == "" {
			return ""
		}
		kept = append(kept, TreeEntry{Mode: "40000", Name: head, OID: child})
	}
	return putObject(store, objTree, buildTree(kept))
}

// FlatEntry is one path in a flattened tree walk.
type FlatEntry struct {
	Path string
	Mode string
	OID  string
}

// flattenTree answers every blob path under treeOid, depth first, as path -> entry.
func flattenTree(store ObjectStore, treeOid string, prefix string, out map[string]FlatEntry) map[string]FlatEntry {
	if out == nil {
		out = make(map[string]FlatEntry)
	}
	if treeOid == "" {
		return out
	}
	object := store[treeOid]
	if object == nil || object.Type != objTree {
		return out
	}
	for _, entry := range parseTree(object.Data) {
		path := entry.Name
		if prefix != "" {
			path = prefix + "/" + entry.Name
		}
		if entry.Mode == "40000" {
			flattenTree(store, entry.OID, path, out)
		} else {
			out[path] = FlatEntry{Path: path, Mode: entry.Mode, OID: entry.OID}
		}
	}
	return out
}

// sortedPaths answers a path map's keys in byte order.
func sortedPaths(paths map[string]FlatEntry) []string {
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// treeFromPaths builds a tree from a flat path map (the merge's output).
func treeFromPaths(store ObjectStore, paths map[string]FlatEntry) string {
	tree := putObject(store, objTree, emptyTreeData)
	for _, path := range sortedPaths(paths) {
		entry := paths[path]
		tree = treeWithPath(store, tree, splitPath(entry.Path), entry.OID, entry.Mode)
	}
	return tree
}

// splitPath splits a slash-separated path the way String.prototype.split('/') does.
func splitPath(path string) []string {
	out := make([]string, 0, 4)
	start := 0
	for index := 0; index <= len(path); index++ {
		if index == len(path) || path[index] == '/' {
			out = append(out, path[start:index])
			start = index + 1
		}
	}
	return out
}

// MergeResult is the outcome of a three-way tree merge.
type MergeResult struct {
	Conflict  bool
	Tree      string
	Conflicts []string
}

// mergeTrees is a path-level three-way merge of ours and theirs over base.
func mergeTrees(store ObjectStore, baseTree string, ourTree string, theirTree string) MergeResult {
	base := flattenTree(store, baseTree, "", nil)
	ours := flattenTree(store, ourTree, "", nil)
	theirs := flattenTree(store, theirTree, "", nil)
	merged := make(map[string]FlatEntry, len(ours))
	for path, entry := range ours {
		merged[path] = entry
	}
	var conflicts []string
	paths := make(map[string]struct{}, len(base)+len(ours)+len(theirs))
	for path := range base {
		paths[path] = struct{}{}
	}
	for path := range ours {
		paths[path] = struct{}{}
	}
	for path := range theirs {
		paths[path] = struct{}{}
	}
	same := func(x *FlatEntry, y *FlatEntry) bool {
		if x == nil && y == nil {
			return true
		}
		if x == nil || y == nil {
			return false
		}
		return x.OID == y.OID && x.Mode == y.Mode
	}
	get := func(source map[string]FlatEntry, path string) *FlatEntry {
		if entry, held := source[path]; held {
			return &entry
		}
		return nil
	}
	for path := range paths {
		b := get(base, path)
		o := get(ours, path)
		t := get(theirs, path)
		if same(o, t) {
			continue
		}
		if same(b, o) {
			if t == nil {
				delete(merged, path)
			} else {
				merged[path] = *t
			}
			continue
		}
		if same(b, t) {
			continue
		}
		conflicts = append(conflicts, path)
	}
	if len(conflicts) > 0 {
		sort.Strings(conflicts)
		return MergeResult{Conflict: true, Conflicts: conflicts}
	}
	return MergeResult{Tree: treeFromPaths(store, merged)}
}
