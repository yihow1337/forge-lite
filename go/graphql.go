// The GraphQL v4 surface: a small parser and executor over a hand-written schema, enough for the
// documents gh and github-mcp-server send, plus the `__type` introspection they feature-detect
// with. A port of src/graphql.ts.
//
// A resolved selection set is a `gobj`: an object that remembers the order its fields were added
// in, because a GraphQL answer must come back in the order the document asked for.

package main

import (
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------- ordered objects

// gobj is a JSON object that keeps its insertion order.
type gobj struct {
	keys []string
	vals []any
	idx  map[string]int
}

func newGobj(capacity int) *gobj {
	return &gobj{
		keys: make([]string, 0, capacity),
		vals: make([]any, 0, capacity),
		idx:  make(map[string]int, capacity),
	}
}

// set adds or replaces a field, keeping an existing field in its original place.
func (o *gobj) set(key string, value any) *gobj {
	if at, held := o.idx[key]; held {
		o.vals[at] = value
		return o
	}
	o.idx[key] = len(o.keys)
	o.keys = append(o.keys, key)
	o.vals = append(o.vals, value)
	return o
}

func (o *gobj) get(key string) (any, bool) {
	at, held := o.idx[key]
	if !held {
		return nil, false
	}
	return o.vals[at], true
}

func (o *gobj) typename() string {
	if value, held := o.get("__typename"); held {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return ""
}

// resolver is a field whose value is computed when it is asked for.
type resolver func(args map[string]any) any

// ---------------------------------------------------------------- the document parser

const (
	tokName = iota
	tokPunct
	tokInt
	tokFloat
	tokString
)

type token struct {
	kind  int
	value string
}

// varRef is a `$name` in an argument value, replaced by the request's variables at execution.
type varRef struct{ name string }

type astField struct {
	name       string
	alias      string
	args       map[string]any
	selections []astNode
}

type astSpread struct {
	typeCondition string
	fragment      string
	selections    []astNode
}

// astNode is one selection: exactly one of field or spread is set.
type astNode struct {
	field  *astField
	spread *astSpread
}

type operation struct {
	kind       string
	name       string
	selections []astNode
}

type document struct {
	operations []operation
	fragments  map[string]*astSpread
}

var punctuators = []string{"...", "(", ")", "{", "}", "[", "]", ":", "=", "$", "!", "@", "|", "&"}

type parseError struct{ message string }

func (e *parseError) Error() string { return e.message }

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

func isNameRest(c byte) bool {
	return isNameStart(c) || (c >= '0' && c <= '9')
}

func isNumberStart(c byte) bool {
	return c == '-' || (c >= '0' && c <= '9')
}

func tokenize(text string) ([]token, error) {
	tokens := make([]token, 0, 64)
	index := 0
	for index < len(text) {
		c := text[index]
		if c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == ',' {
			index++
			continue
		}
		// The UTF-8 byte order mark, which a client may send at the head of a document.
		if c == 0xef && strings.HasPrefix(text[index:], "\xef\xbb\xbf") {
			index += 3
			continue
		}
		if c == '#' {
			for index < len(text) && text[index] != '\n' {
				index++
			}
			continue
		}
		if c == '"' {
			if strings.HasPrefix(text[index:], `"""`) {
				end := strings.Index(text[index+3:], `"""`)
				stop := len(text)
				if end >= 0 {
					stop = index + 3 + end
				}
				tokens = append(tokens, token{kind: tokString, value: text[index+3 : stop]})
				index = stop + 3
				if index > len(text) {
					index = len(text)
				}
				continue
			}
			var out strings.Builder
			index++
			for index < len(text) && text[index] != '"' {
				if text[index] == '\\' && index+1 < len(text) {
					switch text[index+1] {
					case 'n':
						out.WriteByte('\n')
					case 't':
						out.WriteByte('\t')
					case 'r':
						out.WriteByte('\r')
					case 'u':
						if index+6 <= len(text) {
							if code, err := strconv.ParseUint(text[index+2:index+6], 16, 32); err == nil {
								out.WriteRune(rune(code))
							}
							index += 4
						}
					default:
						out.WriteByte(text[index+1])
					}
					index += 2
					continue
				}
				out.WriteByte(text[index])
				index++
			}
			index++
			tokens = append(tokens, token{kind: tokString, value: out.String()})
			continue
		}
		if isNumberStart(c) {
			end := index + 1
			float := false
			for end < len(text) {
				d := text[end]
				if d == '.' || d == 'e' || d == 'E' {
					float = true
				} else if !((d >= '0' && d <= '9') || d == '+' || d == '-') {
					break
				}
				end++
			}
			kind := tokInt
			if float {
				kind = tokFloat
			}
			tokens = append(tokens, token{kind: kind, value: text[index:end]})
			index = end
			continue
		}
		if isNameStart(c) {
			end := index + 1
			for end < len(text) && isNameRest(text[end]) {
				end++
			}
			tokens = append(tokens, token{kind: tokName, value: text[index:end]})
			index = end
			continue
		}
		matched := ""
		for _, candidate := range punctuators {
			if strings.HasPrefix(text[index:], candidate) {
				matched = candidate
				break
			}
		}
		if matched == "" {
			return nil, &parseError{"unexpected character " + jsonQuote(string(c)) + " in the document"}
		}
		tokens = append(tokens, token{kind: tokPunct, value: matched})
		index += len(matched)
	}
	return tokens, nil
}

type parser struct {
	tokens []token
	at     int
}

func (p *parser) peek() *token {
	if p.at < len(p.tokens) {
		return &p.tokens[p.at]
	}
	return nil
}

func (p *parser) next() (token, error) {
	if p.at >= len(p.tokens) {
		return token{}, &parseError{"the document ended early"}
	}
	out := p.tokens[p.at]
	p.at++
	return out, nil
}

func (p *parser) isPunct(value string) bool {
	t := p.peek()
	return t != nil && t.kind == tokPunct && t.value == value
}

func (p *parser) expect(value string) error {
	if !p.isPunct(value) {
		return &parseError{"expected " + jsonQuote(value) + " in the document"}
	}
	p.at++
	return nil
}

func (p *parser) parseDocument() (*document, error) {
	doc := &document{fragments: make(map[string]*astSpread)}
	for p.peek() != nil {
		if p.isPunct("{") {
			selections, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.operations = append(doc.operations, operation{kind: "query", selections: selections})
			continue
		}
		keyword, err := p.next()
		if err != nil {
			return nil, err
		}
		if keyword.kind != tokName {
			return nil, &parseError{"unexpected token " + jsonQuote(keyword.value)}
		}
		if keyword.value == "fragment" {
			name, err := p.next()
			if err != nil {
				return nil, err
			}
			if _, err := p.next(); err != nil { // the "on" keyword
				return nil, err
			}
			typeName, err := p.next()
			if err != nil {
				return nil, err
			}
			selections, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.fragments[name.value] = &astSpread{typeCondition: typeName.value, selections: selections}
			continue
		}
		if keyword.value != "query" && keyword.value != "mutation" && keyword.value != "subscription" {
			return nil, &parseError{"unknown operation " + jsonQuote(keyword.value)}
		}
		name := ""
		if after := p.peek(); after != nil && after.kind == tokName {
			token, _ := p.next()
			name = token.value
		}
		if p.isPunct("(") {
			if err := p.skipParenthesized(); err != nil {
				return nil, err
			}
		}
		if err := p.skipDirectives(); err != nil {
			return nil, err
		}
		selections, err := p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
		doc.operations = append(doc.operations, operation{kind: keyword.value, name: name, selections: selections})
	}
	return doc, nil
}

func (p *parser) skipParenthesized() error {
	if err := p.expect("("); err != nil {
		return err
	}
	depth := 1
	for depth > 0 {
		t, err := p.next()
		if err != nil {
			return err
		}
		if t.kind == tokPunct && t.value == "(" {
			depth++
		} else if t.kind == tokPunct && t.value == ")" {
			depth--
		}
	}
	return nil
}

func (p *parser) skipDirectives() error {
	for p.isPunct("@") {
		if _, err := p.next(); err != nil {
			return err
		}
		if _, err := p.next(); err != nil {
			return err
		}
		if p.isPunct("(") {
			if err := p.skipParenthesized(); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *parser) parseSelectionSet() ([]astNode, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	nodes := make([]astNode, 0, 8)
	for !p.isPunct("}") {
		if p.peek() == nil {
			return nil, &parseError{"the document ended early"}
		}
		if p.isPunct("...") {
			if _, err := p.next(); err != nil {
				return nil, err
			}
			t := p.peek()
			if t != nil && t.kind == tokName && t.value == "on" {
				if _, err := p.next(); err != nil {
					return nil, err
				}
				typeName, err := p.next()
				if err != nil {
					return nil, err
				}
				if err := p.skipDirectives(); err != nil {
					return nil, err
				}
				selections, err := p.parseSelectionSet()
				if err != nil {
					return nil, err
				}
				nodes = append(nodes, astNode{spread: &astSpread{typeCondition: typeName.value, selections: selections}})
				continue
			}
			if t != nil && t.kind == tokName {
				name, _ := p.next()
				if err := p.skipDirectives(); err != nil {
					return nil, err
				}
				nodes = append(nodes, astNode{spread: &astSpread{fragment: name.value}})
				continue
			}
			if err := p.skipDirectives(); err != nil {
				return nil, err
			}
			selections, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			nodes = append(nodes, astNode{spread: &astSpread{selections: selections}})
			continue
		}
		first, err := p.next()
		if err != nil {
			return nil, err
		}
		if first.kind != tokName {
			return nil, &parseError{"expected a field name, got " + jsonQuote(first.value)}
		}
		alias := first.value
		name := first.value
		if p.isPunct(":") {
			if _, err := p.next(); err != nil {
				return nil, err
			}
			named, err := p.next()
			if err != nil {
				return nil, err
			}
			name = named.value
		}
		var args map[string]any
		if p.isPunct("(") {
			if _, err := p.next(); err != nil {
				return nil, err
			}
			args = make(map[string]any, 4)
			for !p.isPunct(")") {
				if p.peek() == nil {
					return nil, &parseError{"the document ended early"}
				}
				key, err := p.next()
				if err != nil {
					return nil, err
				}
				if err := p.expect(":"); err != nil {
					return nil, err
				}
				value, err := p.parseValue()
				if err != nil {
					return nil, err
				}
				args[key.value] = value
			}
			if _, err := p.next(); err != nil {
				return nil, err
			}
		}
		if err := p.skipDirectives(); err != nil {
			return nil, err
		}
		var selections []astNode
		if p.isPunct("{") {
			selections, err = p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
		}
		nodes = append(nodes, astNode{field: &astField{name: name, alias: alias, args: args, selections: selections}})
	}
	if _, err := p.next(); err != nil {
		return nil, err
	}
	return nodes, nil
}

func (p *parser) parseValue() (any, error) {
	if p.isPunct("$") {
		if _, err := p.next(); err != nil {
			return nil, err
		}
		name, err := p.next()
		if err != nil {
			return nil, err
		}
		return varRef{name: name.value}, nil
	}
	if p.isPunct("[") {
		if _, err := p.next(); err != nil {
			return nil, err
		}
		list := make([]any, 0, 4)
		for !p.isPunct("]") {
			if p.peek() == nil {
				return nil, &parseError{"the document ended early"}
			}
			value, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		if _, err := p.next(); err != nil {
			return nil, err
		}
		return list, nil
	}
	if p.isPunct("{") {
		if _, err := p.next(); err != nil {
			return nil, err
		}
		out := make(map[string]any, 4)
		for !p.isPunct("}") {
			if p.peek() == nil {
				return nil, &parseError{"the document ended early"}
			}
			key, err := p.next()
			if err != nil {
				return nil, err
			}
			if err := p.expect(":"); err != nil {
				return nil, err
			}
			value, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			out[key.value] = value
		}
		if _, err := p.next(); err != nil {
			return nil, err
		}
		return out, nil
	}
	t, err := p.next()
	if err != nil {
		return nil, err
	}
	switch t.kind {
	case tokInt:
		parsed, _ := parseIntPrefix(t.value)
		return float64(parsed), nil
	case tokFloat:
		parsed, _ := strconv.ParseFloat(t.value, 64)
		return parsed, nil
	case tokString:
		return t.value, nil
	}
	switch t.value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "null":
		return nil, nil
	}
	return t.value, nil
}

// bind substitutes the request's variables into a parsed argument value.
func bindVars(value any, variables map[string]any) any {
	switch typed := value.(type) {
	case varRef:
		if held, ok := variables[typed.name]; ok && held != nil {
			return held
		}
		return nil
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = bindVars(item, variables)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = bindVars(item, variables)
		}
		return out
	}
	return value
}

// ---------------------------------------------------------------- global ids

func encodeGid(text string) string {
	return base64Of([]byte(text))
}

func decodeGid(id string) []string {
	decoded := base64Decode(id)
	if len(decoded) == 0 {
		return nil
	}
	return strings.Split(string(decoded), "\u0001")
}

func gidPart(parts []string, index int) string {
	if index < len(parts) {
		return parts[index]
	}
	return ""
}

func repoGid(repo *RepoRec) string {
	return encodeGid("R\u0001" + repo.Name)
}

func issueGid(repo *RepoRec, issue *IssueRec) string {
	return encodeGid("I\u0001" + repo.Name + "\u0001" + strconv.Itoa(issue.Number))
}

func pullGid(repo *RepoRec, pull *PullRec) string {
	return encodeGid("P\u0001" + repo.Name + "\u0001" + strconv.Itoa(pull.Number))
}

func commentGid(repo *RepoRec, issueNumber int, id int) string {
	return encodeGid("C\u0001" + repo.Name + "\u0001" + strconv.Itoa(issueNumber) + "\u0001" + strconv.Itoa(id))
}

func cursorGid(index int) string {
	return encodeGid("c\u0001" + strconv.Itoa(index))
}

// ---------------------------------------------------------------- the schema's sources

func userSource(store *Store) *gobj {
	return newGobj(8).
		set("__typename", "User").
		set("id", encodeGid("U\u0001"+store.Viewer)).
		set("login", store.Viewer).
		set("name", store.Viewer).
		set("email", "").
		set("url", "/"+store.Viewer).
		set("avatarUrl", "").
		set("databaseId", store.ViewerID)
}

func labelSource(label *LabelRec) *gobj {
	return newGobj(4).
		set("__typename", "Label").
		set("id", encodeGid("L\u0001"+strconv.Itoa(label.ID))).
		set("name", label.Name).
		set("color", label.Color)
}

func issueSource(store *Store, repo *RepoRec, issue *IssueRec) *gobj {
	state := "OPEN"
	if issue.State == "closed" {
		state = "CLOSED"
	}
	source := newGobj(20)
	source.set("__typename", "Issue").
		set("id", issueGid(repo, issue)).
		set("databaseId", issue.ID).
		set("number", issue.Number).
		set("title", issue.Title).
		set("body", issue.Body).
		set("bodyText", issue.Body).
		set("state", state).
		set("closed", issue.State == "closed").
		set("url", "/"+repo.Owner+"/"+repo.Name+"/issues/"+strconv.Itoa(issue.Number)).
		set("createdAt", epochISO).
		set("updatedAt", epochISO).
		set("author", resolver(func(map[string]any) any { return userSource(store) })).
		set("labels", resolver(func(map[string]any) any {
			nodes := make([]any, 0, len(issue.Labels))
			for _, label := range issue.Labels {
				nodes = append(nodes, labelSource(label))
			}
			return newGobj(3).set("__typename", "LabelConnection").set("totalCount", len(issue.Labels)).set("nodes", nodes)
		})).
		set("comments", resolver(func(map[string]any) any {
			nodes := make([]any, 0, len(issue.Comments))
			for _, comment := range issue.Comments {
				nodes = append(nodes, newGobj(4).
					set("__typename", "IssueComment").
					set("id", commentGid(repo, issue.Number, comment.ID)).
					set("body", comment.Body).
					set("author", resolver(func(map[string]any) any { return userSource(store) })))
			}
			return newGobj(3).set("__typename", "IssueCommentConnection").set("totalCount", len(issue.Comments)).set("nodes", nodes)
		})).
		set("repository", resolver(func(map[string]any) any { return repositorySource(store, repo) })).
		set("assignees", resolver(func(map[string]any) any {
			return newGobj(3).set("__typename", "UserConnection").set("totalCount", 0).set("nodes", []any{})
		})).
		set("milestone", nil)
	return source
}

func pullSource(store *Store, repo *RepoRec, pull *PullRec) *gobj {
	state := "OPEN"
	if pull.Merged {
		state = "MERGED"
	} else if pull.State == "closed" {
		state = "CLOSED"
	}
	mergeable := "UNKNOWN"
	if !pull.Merged {
		if mergeableOf(repo, pull) {
			mergeable = "MERGEABLE"
		} else {
			mergeable = "CONFLICTING"
		}
	}
	source := newGobj(24)
	source.set("__typename", "PullRequest").
		set("id", pullGid(repo, pull)).
		set("databaseId", pull.ID).
		set("number", pull.Number).
		set("title", pull.Title).
		set("body", pull.Body).
		set("state", state).
		set("merged", pull.Merged).
		set("closed", pull.State == "closed").
		set("isDraft", false).
		set("headRefName", pull.Head).
		set("baseRefName", pull.Base).
		set("headRefOid", pull.HeadSha).
		set("baseRefOid", pull.BaseSha).
		set("mergeable", mergeable).
		set("url", "/"+repo.Owner+"/"+repo.Name+"/pull/"+strconv.Itoa(pull.Number)).
		set("createdAt", epochISO).
		set("updatedAt", epochISO).
		set("author", resolver(func(map[string]any) any { return userSource(store) })).
		set("repository", resolver(func(map[string]any) any { return repositorySource(store, repo) })).
		set("files", resolver(func(args map[string]any) any {
			paths := changedPaths(repo, pull)
			first := len(paths)
			if value, ok := args["first"].(float64); ok {
				first = int(value)
			}
			if first < 0 {
				first = 0
			}
			if first > len(paths) {
				first = len(paths)
			}
			page := paths[:first]
			nodes := make([]any, 0, len(page))
			for _, path := range page {
				nodes = append(nodes, newGobj(5).
					set("__typename", "PullRequestChangedFile").
					set("path", path).
					set("additions", 1).
					set("deletions", 0).
					set("changeType", "ADDED"))
			}
			var endCursor any
			if len(page) > 0 {
				endCursor = cursorGid(len(page) - 1)
			}
			return newGobj(4).
				set("__typename", "PullRequestChangedFileConnection").
				set("totalCount", len(paths)).
				set("nodes", nodes).
				set("pageInfo", newGobj(3).
					set("__typename", "PageInfo").
					set("hasNextPage", len(page) < len(paths)).
					set("endCursor", endCursor))
		}))
	return source
}

// changedPaths answers the paths a pull request changes, read from the git trees between its
// merge base and its head.
func changedPaths(repo *RepoRec, pull *PullRec) []string {
	objects := repo.Objects
	headRef := branchTip(repo, pull.Head)
	if headRef == "" {
		headRef = pull.HeadSha
	}
	baseRef := branchTip(repo, pull.Base)
	if baseRef == "" {
		baseRef = pull.BaseSha
	}
	headCommit := commitOf(objects, headRef)
	baseCommit := commitOf(objects, baseRef)
	if headCommit == "" {
		return nil
	}
	ancestor := ""
	if baseCommit != "" {
		ancestor = mergeBase(objects, headCommit, baseCommit)
	}
	ancestorTree := ""
	if ancestor != "" {
		ancestorTree = treeOfCommit(objects, ancestor)
	}
	before := flattenTree(objects, ancestorTree, "", nil)
	after := flattenTree(objects, treeOfCommit(objects, headCommit), "", nil)
	paths := make([]string, 0, len(after))
	for path, entry := range after {
		old, held := before[path]
		if !held || old.OID != entry.OID {
			paths = append(paths, path)
		}
	}
	for path := range before {
		if _, held := after[path]; !held {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}

// connection builds a Relay-style connection over nodes, honouring `first` and `after`.
func connection(typeName string, nodes []any, args map[string]any) *gobj {
	start := 0
	if after, ok := args["after"].(string); ok && after != "" {
		parts := decodeGid(after)
		if index, ok := parseIntPrefix(gidPart(parts, 1)); ok {
			start = index + 1
		}
	}
	if start > len(nodes) {
		start = len(nodes)
	}
	size := len(nodes)
	if first, ok := args["first"].(float64); ok && first > 0 {
		size = int(first)
	}
	end := start + size
	if end > len(nodes) {
		end = len(nodes)
	}
	page := nodes[start:end]
	edges := make([]any, 0, len(page))
	for offset, node := range page {
		edges = append(edges, newGobj(3).
			set("__typename", "Edge").
			set("cursor", cursorGid(start+offset)).
			set("node", node))
	}
	var endCursor any
	var startCursor any
	if len(page) > 0 {
		endCursor = cursorGid(start + len(page) - 1)
		startCursor = cursorGid(start)
	}
	return newGobj(5).
		set("__typename", typeName).
		set("totalCount", len(nodes)).
		set("nodes", page).
		set("edges", edges).
		set("pageInfo", newGobj(5).
			set("__typename", "PageInfo").
			set("hasNextPage", start+len(page) < len(nodes)).
			set("hasPreviousPage", start > 0).
			set("endCursor", endCursor).
			set("startCursor", startCursor))
}

// statesOf reads a connection's `states` argument, uppercased.
func statesOf(args map[string]any) []string {
	list, ok := args["states"].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		out = append(out, strings.ToUpper(anyString(entry)))
	}
	return out
}

func containsString(list []string, value string) bool {
	for _, held := range list {
		if held == value {
			return true
		}
	}
	return false
}

func repositorySource(store *Store, repo *RepoRec) *gobj {
	source := newGobj(32)
	source.set("__typename", "Repository").
		set("id", repoGid(repo)).
		set("databaseId", repo.ID).
		set("name", repo.Name).
		set("nameWithOwner", repo.Owner+"/"+repo.Name).
		set("description", repo.Description).
		set("url", "/"+repo.Owner+"/"+repo.Name).
		set("isPrivate", repo.Private).
		set("isArchived", false).
		set("isFork", false).
		set("hasIssuesEnabled", true).
		set("hasWikiEnabled", true).
		set("hasProjectsEnabled", true).
		set("viewerPermission", "ADMIN").
		set("viewerCanAdminister", true).
		set("createdAt", epochISO).
		set("updatedAt", epochISO).
		set("owner", resolver(func(map[string]any) any { return userSource(store) })).
		set("defaultBranchRef", resolver(func(map[string]any) any {
			tip := branchTip(repo, repo.DefaultBranch)
			if tip == "" {
				return nil
			}
			return newGobj(5).
				set("__typename", "Ref").
				set("id", encodeGid("F\u0001"+repo.Name+"\u0001"+repo.DefaultBranch)).
				set("name", repo.DefaultBranch).
				set("prefix", "refs/heads/").
				set("target", newGobj(3).
					set("__typename", "Commit").
					set("oid", tip).
					set("id", encodeGid("O\u0001"+tip)))
		})).
		set("issue", resolver(func(args map[string]any) any {
			value, ok := args["number"].(float64)
			if !ok {
				return nil
			}
			issue := repo.Issues[int(value)]
			if issue == nil {
				return nil
			}
			return issueSource(store, repo, issue)
		})).
		set("issues", resolver(func(args map[string]any) any {
			states := statesOf(args)
			numbers := make([]int, 0, len(repo.IssueOrder))
			for _, number := range repo.IssueOrder {
				if states == nil {
					numbers = append(numbers, number)
					continue
				}
				issue := repo.Issues[number]
				state := "OPEN"
				if issue.State == "closed" {
					state = "CLOSED"
				}
				if containsString(states, state) {
					numbers = append(numbers, number)
				}
			}
			descending := false
			if orderBy, ok := args["orderBy"].(map[string]any); ok {
				if direction, ok := orderBy["direction"].(string); ok && direction == "DESC" {
					descending = true
				}
			}
			sort.Slice(numbers, func(a, b int) bool {
				if descending {
					return numbers[a] > numbers[b]
				}
				return numbers[a] < numbers[b]
			})
			nodes := make([]any, 0, len(numbers))
			for _, number := range numbers {
				nodes = append(nodes, issueSource(store, repo, repo.Issues[number]))
			}
			return connection("IssueConnection", nodes, args)
		})).
		set("pullRequest", resolver(func(args map[string]any) any {
			value, ok := args["number"].(float64)
			if !ok {
				return nil
			}
			pull := repo.Pulls[int(value)]
			if pull == nil {
				return nil
			}
			return pullSource(store, repo, pull)
		})).
		set("pullRequests", resolver(func(args map[string]any) any {
			states := statesOf(args)
			nodes := make([]any, 0, len(repo.PullOrder))
			for _, number := range repo.PullOrder {
				pull := repo.Pulls[number]
				if states != nil {
					state := "OPEN"
					if pull.Merged {
						state = "MERGED"
					} else if pull.State == "closed" {
						state = "CLOSED"
					}
					if !containsString(states, state) {
						continue
					}
				}
				nodes = append(nodes, pullSource(store, repo, pull))
			}
			return connection("PullRequestConnection", nodes, args)
		})).
		set("labels", resolver(func(args map[string]any) any {
			nodes := make([]any, 0, len(repo.LabelOrder))
			for _, name := range repo.LabelOrder {
				nodes = append(nodes, labelSource(repo.Labels[name]))
			}
			return connection("LabelConnection", nodes, map[string]any{})
		})).
		set("ref", resolver(func(args map[string]any) any {
			qualified := anyString(args["qualifiedName"])
			name := strings.TrimPrefix(qualified, "refs/heads/")
			tip := branchTip(repo, name)
			if tip == "" {
				return nil
			}
			return newGobj(4).
				set("__typename", "Ref").
				set("id", encodeGid("F\u0001"+repo.Name+"\u0001"+name)).
				set("name", name).
				set("target", newGobj(2).set("__typename", "Commit").set("oid", tip))
		}))
	return source
}

// ---------------------------------------------------------------- introspection

// typeFieldOrder is the order the schema's types are introspected in.
var typeFieldOrder = []string{
	"Query", "Mutation", "User", "Repository", "Issue", "PullRequest", "Ref", "Commit", "Label",
	"IssueComment", "IssueConnection", "PullRequestConnection", "PullRequestChangedFileConnection",
	"PullRequestChangedFile", "LabelConnection", "IssueCommentConnection", "PageInfo",
	"CreateIssuePayload", "CloseIssuePayload", "CreatePullRequestPayload", "MergePullRequestPayload",
	"AddCommentPayload",
}

var typeFields = map[string][]string{
	"Query":    {"viewer", "repository", "node", "nodes", "search", "rateLimit", "organization", "user"},
	"Mutation": {"createIssue", "closeIssue", "reopenIssue", "updateIssue", "createPullRequest", "mergePullRequest", "closePullRequest", "addComment"},
	"User":     {"id", "databaseId", "login", "name", "email", "url", "avatarUrl", "repositories"},
	"Repository": {
		"id", "databaseId", "name", "nameWithOwner", "owner", "description", "url", "isPrivate", "isArchived", "isFork",
		"defaultBranchRef", "viewerPermission", "viewerCanAdminister", "hasIssuesEnabled", "hasWikiEnabled", "hasProjectsEnabled",
		"issue", "issues", "pullRequest", "pullRequests", "labels", "ref", "refs", "createdAt", "updatedAt", "stargazerCount",
	},
	"Issue": {"id", "databaseId", "number", "title", "body", "bodyText", "state", "closed", "url", "author", "labels", "comments", "assignees", "milestone", "repository", "createdAt", "updatedAt"},
	"PullRequest": {
		"id", "databaseId", "number", "title", "body", "state", "merged", "closed", "isDraft", "headRefName", "baseRefName",
		"headRefOid", "baseRefOid", "mergeable", "files", "commits", "author", "repository", "url", "createdAt", "updatedAt", "reviews", "comments",
	},
	"Ref":                              {"id", "name", "prefix", "target", "repository"},
	"Commit":                           {"id", "oid", "message", "author", "committedDate", "url"},
	"Label":                            {"id", "name", "color", "description"},
	"IssueComment":                     {"id", "body", "bodyText", "author", "createdAt", "url"},
	"IssueConnection":                  {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestConnection":            {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestChangedFileConnection": {"nodes", "edges", "pageInfo", "totalCount"},
	"PullRequestChangedFile":           {"path", "additions", "deletions", "changeType"},
	"LabelConnection":                  {"nodes", "edges", "pageInfo", "totalCount"},
	"IssueCommentConnection":           {"nodes", "edges", "pageInfo", "totalCount"},
	"PageInfo":                         {"hasNextPage", "hasPreviousPage", "startCursor", "endCursor"},
	"CreateIssuePayload":               {"issue", "clientMutationId"},
	"CloseIssuePayload":                {"issue", "clientMutationId"},
	"CreatePullRequestPayload":         {"pullRequest", "clientMutationId"},
	"MergePullRequestPayload":          {"pullRequest", "clientMutationId"},
	"AddCommentPayload":                {"commentEdge", "subject", "clientMutationId"},
}

var enumValues = map[string][]string{
	"SearchType":               {"ISSUE", "REPOSITORY", "USER", "DISCUSSION"},
	"IssueState":               {"OPEN", "CLOSED"},
	"PullRequestState":         {"OPEN", "CLOSED", "MERGED"},
	"MergeableState":           {"MERGEABLE", "CONFLICTING", "UNKNOWN"},
	"PullRequestMergeMethod":   {"MERGE", "SQUASH", "REBASE"},
	"RepositoryPermission":     {"ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"},
	"IssueOrderField":          {"CREATED_AT", "UPDATED_AT", "COMMENTS"},
	"OrderDirection":           {"ASC", "DESC"},
	"CommentAuthorAssociation": {"OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"},
}

var inputTypes = map[string][]string{
	"CreateIssueInput":       {"repositoryId", "title", "body", "labelIds", "assigneeIds", "clientMutationId"},
	"CloseIssueInput":        {"issueId", "stateReason", "clientMutationId"},
	"CreatePullRequestInput": {"repositoryId", "baseRefName", "headRefName", "title", "body", "draft", "clientMutationId"},
	"MergePullRequestInput":  {"pullRequestId", "mergeMethod", "commitHeadline", "commitBody", "clientMutationId"},
	"AddCommentInput":        {"subjectId", "body", "clientMutationId"},
}

func typeSource(name string) any {
	fields, hasFields := typeFields[name]
	enums, hasEnums := enumValues[name]
	inputs, hasInputs := inputTypes[name]
	if !hasFields && !hasEnums && !hasInputs {
		return nil
	}
	kind := "OBJECT"
	if hasEnums {
		kind = "ENUM"
	} else if hasInputs {
		kind = "INPUT_OBJECT"
	}
	return newGobj(10).
		set("__typename", "__Type").
		set("name", name).
		set("kind", kind).
		set("description", nil).
		set("fields", resolver(func(map[string]any) any {
			if !hasFields {
				return nil
			}
			out := make([]any, 0, len(fields))
			for _, field := range fields {
				out = append(out, newGobj(6).
					set("__typename", "__Field").
					set("name", field).
					set("description", nil).
					set("isDeprecated", false).
					set("deprecationReason", nil).
					set("args", []any{}))
			}
			return out
		})).
		set("enumValues", resolver(func(map[string]any) any {
			if !hasEnums {
				return nil
			}
			out := make([]any, 0, len(enums))
			for _, value := range enums {
				out = append(out, newGobj(5).
					set("__typename", "__EnumValue").
					set("name", value).
					set("description", nil).
					set("isDeprecated", false).
					set("deprecationReason", nil))
			}
			return out
		})).
		set("inputFields", resolver(func(map[string]any) any {
			if !hasInputs {
				return nil
			}
			out := make([]any, 0, len(inputs))
			for _, field := range inputs {
				out = append(out, newGobj(3).
					set("__typename", "__InputValue").
					set("name", field).
					set("description", nil))
			}
			return out
		})).
		set("interfaces", []any{}).
		set("possibleTypes", nil)
}

// ---------------------------------------------------------------- roots

func lookupNode(store *Store, id string) any {
	parts := decodeGid(id)
	switch gidPart(parts, 0) {
	case "R":
		repo := store.repos[gidPart(parts, 1)]
		if repo == nil {
			return nil
		}
		return repositorySource(store, repo)
	case "I":
		repo := store.repos[gidPart(parts, 1)]
		if repo == nil {
			return nil
		}
		number, ok := parseIntPrefix(gidPart(parts, 2))
		if !ok {
			return nil
		}
		issue := repo.Issues[number]
		if issue == nil {
			return nil
		}
		return issueSource(store, repo, issue)
	case "P":
		repo := store.repos[gidPart(parts, 1)]
		if repo == nil {
			return nil
		}
		number, ok := parseIntPrefix(gidPart(parts, 2))
		if !ok {
			return nil
		}
		pull := repo.Pulls[number]
		if pull == nil {
			return nil
		}
		return pullSource(store, repo, pull)
	case "U":
		return userSource(store)
	}
	return nil
}

func queryRoot(store *Store) *gobj {
	types := make([]any, 0, len(typeFieldOrder))
	for _, name := range typeFieldOrder {
		types = append(types, typeSource(name))
	}
	return newGobj(8).
		set("__typename", "Query").
		set("viewer", resolver(func(map[string]any) any { return userSource(store) })).
		set("repository", resolver(func(args map[string]any) any {
			repo := store.repo(anyString(args["owner"]), anyString(args["name"]))
			if repo == nil {
				return nil
			}
			return repositorySource(store, repo)
		})).
		set("node", resolver(func(args map[string]any) any { return lookupNode(store, anyString(args["id"])) })).
		set("nodes", resolver(func(args map[string]any) any {
			list, ok := args["ids"].([]any)
			if !ok {
				return []any{}
			}
			out := make([]any, 0, len(list))
			for _, id := range list {
				out = append(out, lookupNode(store, anyString(id)))
			}
			return out
		})).
		set("rateLimit", newGobj(5).
			set("__typename", "RateLimit").
			set("limit", 5000).
			set("remaining", 5000).
			set("cost", 1).
			set("resetAt", epochISO)).
		set("__type", resolver(func(args map[string]any) any { return typeSource(anyString(args["name"])) })).
		set("__schema", newGobj(5).
			set("__typename", "__Schema").
			set("queryType", newGobj(2).set("__typename", "__Type").set("name", "Query")).
			set("mutationType", newGobj(2).set("__typename", "__Type").set("name", "Mutation")).
			set("types", types).
			set("directives", []any{}))
}

// inputOf answers a mutation's `input` argument, or its arguments themselves.
func inputOf(args map[string]any) map[string]any {
	if input, ok := args["input"].(map[string]any); ok {
		return input
	}
	return args
}

func mutationRoot(store *Store, errors *[]string) *gobj {
	repoOf := func(id string) *RepoRec {
		parts := decodeGid(id)
		if gidPart(parts, 0) != "R" {
			return nil
		}
		return store.repos[gidPart(parts, 1)]
	}
	issueOf := func(id string) (*RepoRec, *IssueRec) {
		parts := decodeGid(id)
		if gidPart(parts, 0) != "I" {
			return nil, nil
		}
		repo := store.repos[gidPart(parts, 1)]
		if repo == nil {
			return nil, nil
		}
		number, ok := parseIntPrefix(gidPart(parts, 2))
		if !ok {
			return repo, nil
		}
		return repo, repo.Issues[number]
	}

	return newGobj(8).
		set("__typename", "Mutation").
		set("createIssue", resolver(func(args map[string]any) any {
			input := inputOf(args)
			repo := repoOf(anyString(input["repositoryId"]))
			if repo == nil {
				*errors = append(*errors, "Could not resolve to a Repository with the given id.")
				return nil
			}
			result := createIssue(store, repo, IssueInput{Title: anyString(input["title"]), Body: jstr(input, "body", "")})
			if result.Status != 201 {
				*errors = append(*errors, "Could not create the issue.")
				return nil
			}
			issue := repo.Issues[repo.NextNumber-1]
			return newGobj(3).
				set("__typename", "CreateIssuePayload").
				set("issue", issueSource(store, repo, issue)).
				set("clientMutationId", nil)
		})).
		set("closeIssue", resolver(func(args map[string]any) any {
			input := inputOf(args)
			repo, issue := issueOf(anyString(input["issueId"]))
			if repo == nil || issue == nil {
				*errors = append(*errors, "Could not resolve to an Issue with the given id.")
				return nil
			}
			issue.State = "closed"
			issue.JSON = nil
			return newGobj(3).
				set("__typename", "CloseIssuePayload").
				set("issue", issueSource(store, repo, issue)).
				set("clientMutationId", nil)
		})).
		set("reopenIssue", resolver(func(args map[string]any) any {
			input := inputOf(args)
			repo, issue := issueOf(anyString(input["issueId"]))
			if repo == nil || issue == nil {
				return nil
			}
			issue.State = "open"
			issue.JSON = nil
			return newGobj(2).
				set("__typename", "ReopenIssuePayload").
				set("issue", issueSource(store, repo, issue))
		})).
		set("createPullRequest", resolver(func(args map[string]any) any {
			input := inputOf(args)
			repo := repoOf(anyString(input["repositoryId"]))
			if repo == nil {
				*errors = append(*errors, "Could not resolve to a Repository with the given id.")
				return nil
			}
			result := createPull(store, repo, PullInput{
				Title: anyString(input["title"]),
				Body:  jstr(input, "body", ""),
				Head:  anyString(input["headRefName"]),
				Base:  anyString(input["baseRefName"]),
			})
			if result.Status != 201 {
				*errors = append(*errors, "Could not create the pull request.")
				return nil
			}
			pull := repo.Pulls[repo.NextNumber-1]
			return newGobj(3).
				set("__typename", "CreatePullRequestPayload").
				set("pullRequest", pullSource(store, repo, pull)).
				set("clientMutationId", nil)
		})).
		set("mergePullRequest", resolver(func(args map[string]any) any {
			input := inputOf(args)
			parts := decodeGid(anyString(input["pullRequestId"]))
			var repo *RepoRec
			var pull *PullRec
			if gidPart(parts, 0) == "P" {
				repo = store.repos[gidPart(parts, 1)]
				if repo != nil {
					if number, ok := parseIntPrefix(gidPart(parts, 2)); ok {
						pull = repo.Pulls[number]
					}
				}
			}
			if repo == nil || pull == nil {
				*errors = append(*errors, "Could not resolve to a PullRequest with the given id.")
				return nil
			}
			result := mergePull(store, repo, pull)
			if result.Status != 200 {
				*errors = append(*errors, "Pull Request is not mergeable.")
				return nil
			}
			return newGobj(3).
				set("__typename", "MergePullRequestPayload").
				set("pullRequest", pullSource(store, repo, pull)).
				set("clientMutationId", nil)
		})).
		set("addComment", resolver(func(args map[string]any) any {
			input := inputOf(args)
			repo, issue := issueOf(anyString(input["subjectId"]))
			if repo == nil || issue == nil {
				*errors = append(*errors, "Could not resolve to a subject with the given id.")
				return nil
			}
			comment := addComment(store, repo, issue, anyString(input["body"]))
			node := newGobj(5).
				set("__typename", "IssueComment").
				set("id", commentGid(repo, issue.Number, comment.ID)).
				set("body", comment.Body).
				set("author", resolver(func(map[string]any) any { return userSource(store) })).
				set("createdAt", epochISO)
			return newGobj(4).
				set("__typename", "AddCommentPayload").
				set("commentEdge", newGobj(3).
					set("__typename", "IssueCommentEdge").
					set("cursor", cursorGid(0)).
					set("node", node)).
				set("subject", issueSource(store, repo, issue)).
				set("clientMutationId", nil)
		}))
}

// ---------------------------------------------------------------- execution

func resolveSelection(source *gobj, nodes []astNode, variables map[string]any, errors *[]string, fragments map[string]*astSpread) *gobj {
	out := newGobj(len(nodes))
	for _, node := range nodes {
		if node.spread != nil {
			target := node.spread
			if target.fragment != "" {
				named, held := fragments[target.fragment]
				if !held {
					continue
				}
				target = named
			}
			if target.typeCondition != "" && target.typeCondition != source.typename() {
				continue
			}
			merged := resolveSelection(source, target.selections, variables, errors, fragments)
			for index, key := range merged.keys {
				out.set(key, merged.vals[index])
			}
			continue
		}
		field := node.field
		if field.name == "__typename" {
			out.set(field.alias, source.typename())
			continue
		}
		slot, held := source.get(field.name)
		if !held {
			*errors = append(*errors, "Field '"+field.name+"' doesn't exist on type '"+source.typename()+"'")
			out.set(field.alias, nil)
			continue
		}
		value := slot
		if resolve, ok := slot.(resolver); ok {
			args := make(map[string]any, len(field.args))
			for key, raw := range field.args {
				args[key] = bindVars(raw, variables)
			}
			value = resolve(args)
		}
		out.set(field.alias, applyValue(value, field, variables, errors, fragments))
	}
	return out
}

func applyValue(value any, field *astField, variables map[string]any, errors *[]string, fragments map[string]*astSpread) any {
	if value == nil {
		return nil
	}
	if list, ok := value.([]any); ok {
		out := make([]any, 0, len(list))
		for _, item := range list {
			out = append(out, applyValue(item, field, variables, errors, fragments))
		}
		return out
	}
	object, isObject := value.(*gobj)
	if len(field.selections) == 0 {
		if isObject {
			return nil
		}
		return value
	}
	if !isObject {
		return nil
	}
	return resolveSelection(object, field.selections, variables, errors, fragments)
}

// writeGqlValue appends one resolved value as JSON.
func writeGqlValue(b *jb, value any) {
	switch typed := value.(type) {
	case nil:
		b.buf = append(b.buf, "null"...)
	case string:
		b.buf = appendJSONString(b.buf, typed)
	case bool:
		if typed {
			b.buf = append(b.buf, "true"...)
		} else {
			b.buf = append(b.buf, "false"...)
		}
	case int:
		b.buf = strconv.AppendInt(b.buf, int64(typed), 10)
	case float64:
		b.buf = append(b.buf, formatNumber(typed)...)
	case []any:
		b.openArray()
		for _, item := range typed {
			b.item()
			writeGqlValue(b, item)
			b.comma = true
		}
		b.closeArray()
	case *gobj:
		b.openObject()
		for index, key := range typed.keys {
			b.key(key)
			writeGqlValue(b, typed.vals[index])
			b.comma = true
		}
		b.closeObject()
	default:
		b.buf = append(b.buf, "null"...)
	}
}

// executeGraphQL runs one operation document against the store and appends its answer body.
func executeGraphQL(b *jb, store *Store, body any) {
	writeErrors := func(messages []string) {
		b.openObject()
		b.null("data")
		b.arr("errors")
		for _, message := range messages {
			b.item()
			b.openObject()
			b.str("message", message)
			b.closeObject()
		}
		b.closeArray()
		b.closeObject()
	}

	request := jsonObj(body)
	query := jstr(request, "query", "")
	variables := jsonObj(request["variables"])
	operationName, hasOperationName := jstrOk(request, "operationName")
	if strings.TrimSpace(query) == "" {
		writeErrors([]string{"No query string was present"})
		return
	}

	tokens, err := tokenize(query)
	if err != nil {
		writeErrors([]string{"Parse error: " + err.Error()})
		return
	}
	parsed := &parser{tokens: tokens}
	doc, err := parsed.parseDocument()
	if err != nil {
		writeErrors([]string{"Parse error: " + err.Error()})
		return
	}

	var chosen *operation
	if !hasOperationName {
		if len(doc.operations) > 0 {
			chosen = &doc.operations[0]
		}
	} else {
		for index := range doc.operations {
			if doc.operations[index].name == operationName {
				chosen = &doc.operations[index]
				break
			}
		}
	}
	if chosen == nil {
		writeErrors([]string{"The document holds no operation to run"})
		return
	}

	errors := make([]string, 0, 4)
	var root *gobj
	if chosen.kind == "mutation" {
		root = mutationRoot(store, &errors)
	} else {
		root = queryRoot(store)
	}
	data := resolveSelection(root, chosen.selections, variables, &errors, doc.fragments)
	if len(errors) > 0 {
		writeErrors(errors)
		return
	}
	b.openObject()
	b.key("data")
	writeGqlValue(b, data)
	b.closeObject()
}
