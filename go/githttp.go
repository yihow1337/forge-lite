// git smart HTTP: the ref advertisement (v2 capabilities and the v0 preamble), upload-pack
// (protocol v2 ls-refs and fetch, with a v0 fallback) and receive-pack (v0 only).
//
// Every answer is one buffer. A repository's advertisement and fetch answers are cached against
// its version counter, so the benchmark's 50 concurrent depth-1 clones replay one prebuilt body.
// A port of src/git/http.ts.

package main

import (
	"sort"
	"strconv"
	"strings"
)

// gitAgent is the agent string this forge advertises.
const gitAgent = "makefun-forge/1.0"

// GitReply is one answer the git surface produces.
type GitReply struct {
	Status int
	Type   string
	Body   []byte
}

const (
	uploadAdvertType  = "application/x-git-upload-pack-advertisement"
	receiveAdvertType = "application/x-git-receive-pack-advertisement"
	uploadResultType  = "application/x-git-upload-pack-result"
	receiveResultType = "application/x-git-receive-pack-result"
)

// v2Capabilities is the protocol v2 capability advertisement, the same bytes for every repository.
var v2Capabilities = func() []byte {
	out := make([]byte, 0, 128)
	out = appendPktText(out, "version 2\n")
	out = appendPktText(out, "agent="+gitAgent+"\n")
	out = appendPktText(out, "ls-refs=unborn\n")
	out = appendPktText(out, "fetch=shallow\n")
	out = appendPktText(out, "object-format=sha1\n")
	out = append(out, flushText...)
	return out
}()

const uploadV0Caps = "multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow " +
	"deepen-since deepen-not no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want " +
	"object-format=sha1 agent=" + gitAgent

const receiveV0Caps = "report-status report-status-v2 delete-refs side-band-64k ofs-delta object-format=sha1 agent=" + gitAgent

func textReply(status int, text string) *GitReply {
	return &GitReply{Status: status, Type: "text/plain; charset=utf-8", Body: []byte(text)}
}

// advertisedRef is one line of a ref advertisement.
type advertisedRef struct {
	Name         string
	OID          string
	Peeled       string
	SymrefTarget string
	Unborn       bool
}

// advertisedRefs answers the refs a repository advertises, HEAD first, every other ref in name order.
func advertisedRefs(repo *RepoRec) []advertisedRef {
	headRef := "refs/heads/" + repo.DefaultBranch
	out := make([]advertisedRef, 0, len(repo.Refs)+1)
	if headOid, held := repo.Refs[headRef]; held {
		out = append(out, advertisedRef{Name: "HEAD", OID: headOid, SymrefTarget: headRef})
	} else {
		out = append(out, advertisedRef{Name: "HEAD", OID: zeroOID, SymrefTarget: headRef, Unborn: true})
	}
	for _, name := range refNames(repo) {
		oid := repo.Refs[name]
		entry := advertisedRef{Name: name, OID: oid}
		if object := repo.Objects[oid]; object != nil && object.Type == objTag {
			if target := peel(repo.Objects, oid); target != "" {
				entry.Peeled = target
			}
		}
		out = append(out, entry)
	}
	return out
}

// v0Advertisement builds the v0 ref advertisement body for one service.
func v0Advertisement(repo *RepoRec, service string, caps string) []byte {
	out := make([]byte, 0, 256+len(repo.Refs)*64)
	out = appendPktText(out, "# service="+service+"\n")
	out = append(out, flushText...)
	first := true
	for _, ref := range advertisedRefs(repo) {
		if ref.Unborn {
			continue
		}
		if first {
			out = appendPktText(out, ref.OID+" "+ref.Name+"\x00"+caps+"\n")
			first = false
		} else {
			out = appendPktText(out, ref.OID+" "+ref.Name+"\n")
		}
		if ref.Peeled != "" {
			out = appendPktText(out, ref.Peeled+" "+ref.Name+"^{}\n")
		}
	}
	if first {
		out = appendPktText(out, zeroOID+" capabilities^{}\x00"+caps+"\n")
	}
	return append(out, flushText...)
}

// uploadCaps is the capability list a v0 upload-pack advertisement carries.
func uploadCaps(repo *RepoRec) string {
	return uploadV0Caps + " symref=HEAD:refs/heads/" + repo.DefaultBranch
}

// ---------------------------------------------------------------- ls-refs

type lsRefsArgs struct {
	prefixes []string
	peel     bool
	symrefs  bool
	unborn   bool
}

func lsRefs(repo *RepoRec, args lsRefsArgs) []byte {
	out := make([]byte, 0, 256+len(repo.Refs)*64)
	for _, ref := range advertisedRefs(repo) {
		if ref.Unborn && !args.unborn {
			continue
		}
		if len(args.prefixes) > 0 {
			matched := false
			for _, prefix := range args.prefixes {
				if strings.HasPrefix(ref.Name, prefix) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		var line string
		if ref.Unborn {
			line = "unborn " + ref.Name
		} else {
			line = ref.OID + " " + ref.Name
		}
		if args.symrefs && ref.SymrefTarget != "" {
			line += " symref-target:" + ref.SymrefTarget
		}
		if args.peel && ref.Peeled != "" {
			line += " peeled:" + ref.Peeled
		}
		out = appendPktText(out, line+"\n")
	}
	return append(out, flushText...)
}

// ---------------------------------------------------------------- fetch

type fetchArgs struct {
	wants   []string
	haves   []string
	shallow []string
	depth   int
	hasDeep bool
	done    bool
}

type fetchPlan struct {
	objects      []*GitObject
	shallowLines []string
}

func parentsOf(repo *RepoRec, oid string) []string {
	object := repo.Objects[oid]
	if object == nil || object.Type != objCommit {
		return nil
	}
	return parseCommit(object.Data).Parents
}

// planFetch answers which objects a fetch must send, and the shallow boundary it moves the client to.
func planFetch(repo *RepoRec, args fetchArgs) fetchPlan {
	store := repo.Objects
	clientShallow := newOidSet()
	for _, oid := range args.shallow {
		clientShallow.add(oid)
	}
	var haveClosure *oidSet
	if len(args.haves) > 0 {
		haveClosure = reachable(store, args.haves, clientShallow)
	}
	var shallowLines []string
	var send *oidSet

	if args.hasDeep && args.depth > 0 {
		level := make(map[string]int)
		window := newOidSet()
		boundary := newOidSet()
		type step struct {
			oid   string
			depth int
		}
		queue := make([]step, 0, 32)
		for _, want := range args.wants {
			if commit := commitOf(store, want); commit != "" {
				queue = append(queue, step{commit, 1})
			}
		}
		for len(queue) > 0 {
			item := queue[0]
			queue = queue[1:]
			if known, held := level[item.oid]; held && known <= item.depth {
				continue
			}
			level[item.oid] = item.depth
			window.add(item.oid)
			parents := parentsOf(repo, item.oid)
			if item.depth < args.depth {
				for _, parent := range parents {
					queue = append(queue, step{parent, item.depth + 1})
				}
			} else if len(parents) > 0 {
				boundary.add(item.oid)
			}
		}
		send = reachable(store, window.order, window)
		for _, oid := range boundary.order {
			if !clientShallow.has(oid) {
				shallowLines = append(shallowLines, "shallow "+oid)
			}
		}
		for _, oid := range clientShallow.order {
			if window.has(oid) && !boundary.has(oid) {
				shallowLines = append(shallowLines, "unshallow "+oid)
			}
		}
		// A want that is not a commit (an annotated tag) still travels whole.
		for _, want := range args.wants {
			if commitOf(store, want) == want {
				continue
			}
			for _, oid := range reachable(store, []string{want}, window).order {
				send.add(oid)
			}
		}
	} else {
		send = reachable(store, args.wants, nil)
	}

	objects := make([]*GitObject, 0, send.len())
	for _, oid := range send.order {
		if haveClosure != nil && haveClosure.has(oid) {
			continue
		}
		if object := store[oid]; object != nil {
			objects = append(objects, object)
		}
	}
	return fetchPlan{objects: objects, shallowLines: shallowLines}
}

// fetchCacheKey names one fetch answer: everything the client asked for.
func fetchCacheKey(prefix string, args fetchArgs) string {
	var key strings.Builder
	key.WriteString(prefix)
	key.WriteByte('|')
	if args.hasDeep {
		key.WriteString(strconv.Itoa(args.depth))
	} else {
		key.WriteByte('0')
	}
	for _, group := range [][]string{args.wants, args.haves, args.shallow} {
		key.WriteByte('|')
		sorted := make([]string, len(group))
		copy(sorted, group)
		sort.Strings(sorted)
		key.WriteString(strings.Join(sorted, ","))
	}
	return key.String()
}

func fetchBody(repo *RepoRec, args fetchArgs) []byte {
	return cachedAnswer(repo, fetchCacheKey("fetch", args), func() []byte {
		plan := planFetch(repo, args)
		pack := writePack(plan.objects)
		out := make([]byte, 0, len(pack)+len(pack)/sidebandChunk*5+256)
		if len(plan.shallowLines) > 0 {
			out = appendPktText(out, "shallow-info\n")
			for _, line := range plan.shallowLines {
				out = appendPktText(out, line+"\n")
			}
			out = append(out, delimText...)
		}
		out = appendPktText(out, "packfile\n")
		out = appendSidebandChunks(out, pack)
		return append(out, flushText...)
	})
}

func fetchBodyV0(repo *RepoRec, args fetchArgs) []byte {
	return cachedAnswer(repo, fetchCacheKey("fetch0", args), func() []byte {
		plan := planFetch(repo, args)
		pack := writePack(plan.objects)
		out := make([]byte, 0, len(pack)+len(pack)/sidebandChunk*5+256)
		if len(plan.shallowLines) > 0 {
			for _, line := range plan.shallowLines {
				out = appendPktText(out, line+"\n")
			}
			out = append(out, flushText...)
		}
		out = appendPktText(out, "NAK\n")
		out = appendSidebandChunks(out, pack)
		return append(out, flushText...)
	})
}

// ---------------------------------------------------------------- request parsing

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

// lineOf answers one pkt-line's payload as text, without its trailing newline.
func lineOf(payload []byte) string {
	end := len(payload)
	if end > 0 && payload[end-1] == '\n' {
		end--
	}
	return string(payload[:end])
}

type receiveRequest struct {
	commands []pushCommand
	caps     map[string]bool
	pack     []byte
}

func parseReceiveRequest(body []byte) (receiveRequest, error) {
	packets, offset, err := decodePktLines(body, 0, true)
	if err != nil {
		return receiveRequest{}, err
	}
	out := receiveRequest{caps: make(map[string]bool, 8), pack: body[offset:]}
	first := true
	for _, packet := range packets {
		if packet.Kind != pktData {
			continue
		}
		line := lineOf(packet.Payload)
		if first {
			if nul := strings.IndexByte(line, 0); nul >= 0 {
				for _, cap := range strings.Split(line[nul+1:], " ") {
					if cap == "" {
						continue
					}
					if equals := strings.IndexByte(cap, '='); equals >= 0 {
						cap = cap[:equals]
					}
					out.caps[cap] = true
				}
				line = line[:nul]
			}
			first = false
		}
		firstSpace := strings.IndexByte(line, ' ')
		if firstSpace < 0 {
			continue
		}
		secondSpace := strings.IndexByte(line[firstSpace+1:], ' ')
		if secondSpace < 0 {
			continue
		}
		secondSpace += firstSpace + 1
		if secondSpace+1 >= len(line) {
			continue
		}
		out.commands = append(out.commands, pushCommand{
			oldOID: line[:firstSpace],
			newOID: line[firstSpace+1 : secondSpace],
			ref:    line[secondSpace+1:],
		})
	}
	return out, nil
}

// ---------------------------------------------------------------- the surface

// GitHttpRequest is one request as the git surface reads it.
type GitHttpRequest struct {
	Method        string
	Segments      []string
	Query         string
	GitProtocolV2 bool
	Body          []byte
}

// handleGit serves one git smart-HTTP request; nil when the path is not this surface's.
func handleGit(store *Store, request *GitHttpRequest) *GitReply {
	segments := request.Segments
	if len(segments) < 3 {
		return nil
	}
	owner := segments[0]
	rawRepo := segments[1]
	if !strings.HasSuffix(rawRepo, ".git") {
		return nil
	}
	name := rawRepo[:len(rawRepo)-4]
	tail := ""
	if len(segments) == 3 {
		tail = segments[2]
	} else if len(segments) == 4 && segments[2] == "info" && segments[3] == "refs" {
		tail = "info/refs"
	}
	if tail != "info/refs" && tail != "git-upload-pack" && tail != "git-receive-pack" {
		return nil
	}
	store.latchOwner(owner)
	repo := store.repo(owner, name)

	if tail == "info/refs" {
		if request.Method != "GET" {
			return textReply(405, "method not allowed\n")
		}
		service, _ := queryGet(request.Query, "service")
		if service != "git-upload-pack" && service != "git-receive-pack" {
			return textReply(403, "dumb http is not supported\n")
		}
		if repo == nil {
			return textReply(404, "repository not found\n")
		}
		if service == "git-upload-pack" {
			if request.GitProtocolV2 {
				return &GitReply{Status: 200, Type: uploadAdvertType, Body: v2Capabilities}
			}
			body := cachedAnswer(repo, "adv0u", func() []byte { return v0Advertisement(repo, service, uploadCaps(repo)) })
			return &GitReply{Status: 200, Type: uploadAdvertType, Body: body}
		}
		body := cachedAnswer(repo, "adv0r", func() []byte { return v0Advertisement(repo, service, receiveV0Caps) })
		return &GitReply{Status: 200, Type: receiveAdvertType, Body: body}
	}

	if request.Method != "POST" {
		return textReply(405, "method not allowed\n")
	}
	if repo == nil {
		return textReply(404, "repository not found\n")
	}

	if tail == "git-upload-pack" {
		reply, err := uploadPack(repo, request)
		if err != nil {
			return textReply(400, "bad request: "+err.Error()+"\n")
		}
		return reply
	}

	reply, err := receivePack(repo, request)
	if err != nil {
		return textReply(400, "bad request: "+err.Error()+"\n")
	}
	return reply
}

type gitError struct{ message string }

func (e *gitError) Error() string { return e.message }

func uploadPack(repo *RepoRec, request *GitHttpRequest) (*GitReply, error) {
	packets, _, err := decodePktLines(request.Body, 0, false)
	if err != nil {
		return nil, err
	}
	lines := make([]string, 0, len(packets))
	for _, packet := range packets {
		if packet.Kind == pktData {
			lines = append(lines, lineOf(packet.Payload))
		}
	}

	command := ""
	for _, line := range lines {
		if strings.HasPrefix(line, "command=") {
			command = line[len("command="):]
			break
		}
	}

	if command == "ls-refs" {
		args := lsRefsArgs{}
		for _, line := range lines {
			switch {
			case line == "peel":
				args.peel = true
			case line == "symrefs":
				args.symrefs = true
			case line == "unborn":
				args.unborn = true
			case strings.HasPrefix(line, "ref-prefix "):
				args.prefixes = append(args.prefixes, line[len("ref-prefix "):])
			}
		}
		var key strings.Builder
		key.WriteString("ls|")
		for _, flag := range []bool{args.peel, args.symrefs, args.unborn} {
			if flag {
				key.WriteByte('1')
			} else {
				key.WriteByte('0')
			}
		}
		key.WriteByte('|')
		key.WriteString(strings.Join(args.prefixes, ","))
		body := cachedAnswer(repo, key.String(), func() []byte { return lsRefs(repo, args) })
		return &GitReply{Status: 200, Type: uploadResultType, Body: body}, nil
	}

	args := fetchArgs{}
	sawWant := false
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "want ") && len(line) >= 45:
			if oid := line[5:45]; isOid(oid) {
				args.wants = append(args.wants, oid)
			}
			sawWant = true
		case strings.HasPrefix(line, "want "):
			sawWant = true
		case strings.HasPrefix(line, "have ") && len(line) >= 45:
			if oid := line[5:45]; isOid(oid) {
				args.haves = append(args.haves, oid)
			}
		case strings.HasPrefix(line, "shallow ") && len(line) >= 48:
			if oid := line[8:48]; isOid(oid) {
				args.shallow = append(args.shallow, oid)
			}
		case strings.HasPrefix(line, "deepen "):
			if depth, ok := parseIntPrefix(line[7:]); ok {
				args.depth = depth
			}
			args.hasDeep = true
		case line == "done":
			args.done = true
		}
	}
	if !sawWant {
		return nil, &gitError{"no want line in the request"}
	}

	deduped := make([]string, 0, len(args.wants))
	seen := make(map[string]struct{}, len(args.wants))
	for _, oid := range args.wants {
		if _, held := seen[oid]; held {
			continue
		}
		seen[oid] = struct{}{}
		if _, held := repo.Objects[oid]; held {
			deduped = append(deduped, oid)
		}
	}
	args.wants = deduped
	haves := make([]string, 0, len(args.haves))
	for _, oid := range args.haves {
		if _, held := repo.Objects[oid]; held {
			haves = append(haves, oid)
		}
	}
	args.haves = haves

	if command == "fetch" {
		return &GitReply{Status: 200, Type: uploadResultType, Body: fetchBody(repo, args)}, nil
	}
	return &GitReply{Status: 200, Type: uploadResultType, Body: fetchBodyV0(repo, args)}, nil
}

func receivePack(repo *RepoRec, request *GitHttpRequest) (*GitReply, error) {
	parsed, err := parseReceiveRequest(request.Body)
	if err != nil {
		return nil, err
	}
	sidebandWanted := parsed.caps["side-band-64k"] || parsed.caps["side-band"]
	report := make([]byte, 0, 128+len(parsed.commands)*64)
	unpackDetail := "ok"
	if len(parsed.pack) > 0 {
		objects, err := readPack(parsed.pack, repo.Objects)
		if err != nil {
			unpackDetail = "index-pack failed: " + err.Error()
		} else {
			for _, held := range objects {
				if _, already := repo.Objects[held.OID]; !already {
					repo.Objects[held.OID] = held.Object
				}
			}
		}
	}
	report = appendPktText(report, "unpack "+unpackDetail+"\n")

	changed := false
	for _, command := range parsed.commands {
		if unpackDetail != "ok" {
			report = appendPktText(report, "ng "+command.ref+" unpacker error\n")
			continue
		}
		current, held := repo.Refs[command.ref]
		if command.newOID == zeroOID {
			if !held {
				report = appendPktText(report, "ng "+command.ref+" deletion of a ref that does not exist\n")
				continue
			}
			delete(repo.Refs, command.ref)
			changed = true
			report = appendPktText(report, "ok "+command.ref+"\n")
			continue
		}
		if _, exists := repo.Objects[command.newOID]; !exists {
			report = appendPktText(report, "ng "+command.ref+" missing necessary objects\n")
			continue
		}
		if !held || current == command.newOID || isAncestor(repo.Objects, current, command.newOID) {
			repo.Refs[command.ref] = command.newOID
			changed = true
			report = appendPktText(report, "ok "+command.ref+"\n")
			continue
		}
		report = appendPktText(report, "ng "+command.ref+" non-fast-forward\n")
	}
	if changed || len(parsed.pack) > 0 {
		touchGit(repo)
	}

	inner := string(report) + flushText
	var body []byte
	if sidebandWanted {
		body = appendSidebandText(make([]byte, 0, len(inner)+16), inner)
		body = append(body, flushText...)
	} else {
		body = []byte(inner)
	}
	return &GitReply{Status: 200, Type: receiveResultType, Body: body}, nil
}
