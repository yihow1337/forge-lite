// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over the streamable-HTTP transport.
//
// Both eras are served: `server/discover` (revision 2026-07-28) and the `initialize` handshake of
// the earlier revisions. The tools act on the same store the REST surface serves -- every call is
// routed through handleRest, so an object created over MCP reads back identically over /api/v3.
// A port of src/mcp.ts.

package main

import (
	"strconv"
	"strings"
)

// mcpVersions is the revision this server prefers, and the ones it says it supports.
var mcpVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"}

const serverInfoJSON = `{"name":"makefun-forge","version":"1.0.0"}`

// McpReply is one answer the MCP endpoint produces.
type McpReply struct {
	Status int
	Body   []byte
}

type toolProperty struct {
	Name        string
	Type        string
	Description string
}

type toolSpec struct {
	Name        string
	Title       string
	Description string
	Required    []string
	Properties  []toolProperty
}

var toolSpecs = []toolSpec{
	{
		Name:        "create_repo",
		Title:       "Create repository",
		Description: "Create a new repository owned by the authenticated user.",
		Required:    []string{"name"},
		Properties: []toolProperty{
			{"name", "string", "The name of the repository to create."},
			{"description", "string", "A short description of the repository."},
			{"private", "boolean", "Whether the repository is private."},
		},
	},
	{
		Name:        "get_repo",
		Title:       "Get repository",
		Description: "Read one repository by owner and name.",
		Required:    []string{"owner", "repo"},
		Properties: []toolProperty{
			{"owner", "string", "The repository owner login."},
			{"repo", "string", "The repository name."},
		},
	},
	{
		Name:        "create_issue",
		Title:       "Create issue",
		Description: "Open a new issue in a repository.",
		Required:    []string{"owner", "repo", "title"},
		Properties: []toolProperty{
			{"owner", "string", "The repository owner login."},
			{"repo", "string", "The repository name."},
			{"title", "string", "The issue title."},
			{"body", "string", "The issue body."},
		},
	},
	{
		Name:        "list_issues",
		Title:       "List issues",
		Description: "List the issues of a repository, optionally filtered by state.",
		Required:    []string{"owner", "repo"},
		Properties: []toolProperty{
			{"owner", "string", "The repository owner login."},
			{"repo", "string", "The repository name."},
			{"state", "string", "open, closed or all (open by default)."},
		},
	},
	{
		Name:        "create_pull_request",
		Title:       "Create pull request",
		Description: "Open a pull request from a head branch into a base branch.",
		Required:    []string{"owner", "repo", "title", "head", "base"},
		Properties: []toolProperty{
			{"owner", "string", "The repository owner login."},
			{"repo", "string", "The repository name."},
			{"title", "string", "The pull request title."},
			{"body", "string", "The pull request body."},
			{"head", "string", "The branch the changes are on."},
			{"base", "string", "The branch the changes are merged into."},
		},
	},
	{
		Name:        "merge_pull_request",
		Title:       "Merge pull request",
		Description: "Merge an open pull request as a squash commit on its base branch.",
		Required:    []string{"owner", "repo", "pull_number"},
		Properties: []toolProperty{
			{"owner", "string", "The repository owner login."},
			{"repo", "string", "The repository name."},
			{"pull_number", "number", "The pull request number."},
		},
	},
}

// toolsJSON is the exact `tools` array two tools/list calls must answer, byte for byte.
var toolsJSON = func() []byte {
	b := &jb{}
	b.openArray()
	for index := range toolSpecs {
		tool := &toolSpecs[index]
		b.item()
		b.openObject()
		b.str("name", tool.Name)
		b.str("title", tool.Title)
		b.str("description", tool.Description)
		b.obj("inputSchema")
		b.str("type", "object")
		b.obj("properties")
		for _, property := range tool.Properties {
			b.obj(property.Name)
			b.str("type", property.Type)
			b.str("description", property.Description)
			b.closeObject()
		}
		b.closeObject()
		b.arr("required")
		for _, name := range tool.Required {
			b.itemStr(name)
		}
		b.closeArray()
		b.bool("additionalProperties", false)
		b.closeObject()
		b.closeObject()
	}
	b.closeArray()
	return b.buf
}()

var discoverResult = func() []byte {
	b := &jb{}
	b.openObject()
	b.str("resultType", "discover")
	b.arr("supportedVersions")
	for _, version := range mcpVersions {
		b.itemStr(version)
	}
	b.closeArray()
	b.obj("capabilities")
	b.obj("tools")
	b.bool("listChanged", false)
	b.closeObject()
	b.closeObject()
	b.str("instructions", "A GitHub-compatible forge: create repositories, issues and pull requests, and merge them.")
	b.raw("serverInfo", []byte(serverInfoJSON))
	b.obj("_meta")
	b.raw("io.modelcontextprotocol/serverInfo", []byte(serverInfoJSON))
	b.closeObject()
	b.closeObject()
	return b.buf
}()

// appendRPCID appends a JSON-RPC id, which may be a string, a number or null.
func appendRPCID(dst []byte, id any) []byte {
	switch typed := id.(type) {
	case string:
		return appendJSONString(dst, typed)
	case float64:
		return append(dst, formatNumber(typed)...)
	case bool:
		if typed {
			return append(dst, "true"...)
		}
		return append(dst, "false"...)
	}
	return append(dst, "null"...)
}

func resultBody(id any, result []byte) []byte {
	out := make([]byte, 0, len(result)+48)
	out = append(out, `{"jsonrpc":"2.0","id":`...)
	out = appendRPCID(out, id)
	out = append(out, `,"result":`...)
	out = append(out, result...)
	return append(out, '}')
}

func errorBody(id any, code int, message string) []byte {
	out := make([]byte, 0, len(message)+96)
	out = append(out, `{"jsonrpc":"2.0","id":`...)
	out = appendRPCID(out, id)
	out = append(out, `,"error":{"code":`...)
	out = strconv.AppendInt(out, int64(code), 10)
	out = append(out, `,"message":`...)
	out = appendJSONString(out, message)
	return append(out, '}', '}')
}

// toolResult builds a tools/call result: the text content, optional structured content, and the
// isError flag a failed tool call carries.
func toolResult(text string, structured []byte, isError bool) []byte {
	b := &jb{}
	b.openObject()
	b.arr("content")
	b.item()
	b.openObject()
	b.str("type", "text")
	b.str("text", text)
	b.closeObject()
	b.closeArray()
	if structured != nil {
		b.raw("structuredContent", structured)
	}
	if isError {
		b.bool("isError", true)
	}
	b.closeObject()
	return b.buf
}

func restCall(store *Store, method string, segments []string, body any, query string) ApiReply {
	return handleRest(store, &ApiRequest{
		Method:     method,
		Segments:   segments,
		Query:      query,
		JSON:       body,
		Authorized: true,
		Host:       "mcp",
	})
}

// stringArg answers the first of names that carries a usable string.
func stringArg(args map[string]any, names ...string) string {
	for _, name := range names {
		switch value := args[name].(type) {
		case string:
			if value != "" {
				return value
			}
		case float64:
			return formatNumber(value)
		}
	}
	return ""
}

// numberArg answers the first of names that carries a number, or a string of digits.
func numberArg(args map[string]any, names ...string) (int, bool) {
	for _, name := range names {
		switch value := args[name].(type) {
		case float64:
			return int(value), true
		case string:
			digits := value != ""
			for index := 0; index < len(value); index++ {
				if value[index] < '0' || value[index] > '9' {
					digits = false
					break
				}
			}
			if digits {
				parsed, _ := parseIntPrefix(value)
				return parsed, true
			}
		}
	}
	return 0, false
}

func missingArgs(names []string) []byte {
	b := &jb{}
	b.openObject()
	b.str("error", "missing_arguments")
	b.arr("missing")
	for _, name := range names {
		b.itemStr(name)
	}
	b.closeArray()
	b.closeObject()
	return toolResult("missing required argument(s): "+strings.Join(names, ", "), b.buf, true)
}

func failedCall(reply ApiReply) []byte {
	message := "HTTP " + strconv.Itoa(reply.Status)
	if reply.Body != nil {
		message = string(reply.Body)
	}
	b := &jb{}
	b.openObject()
	b.str("error", "request_failed")
	b.num("status", reply.Status)
	b.closeObject()
	return toolResult("the request failed with HTTP "+strconv.Itoa(reply.Status)+": "+message, b.buf, true)
}

func okCall(reply ApiReply) []byte {
	text := "{}"
	if reply.Body != nil {
		text = string(reply.Body)
	}
	var structured []byte
	if parsed, ok := parseJSON([]byte(text)); ok && !isJSONArr(parsed) {
		structured = []byte(text)
	}
	return toolResult(text, structured, false)
}

// bareName folds a tool name to its letters and digits, so `github.create_issue` still finds
// `create_issue`.
func bareName(name string) string {
	var out strings.Builder
	for index := 0; index < len(name); index++ {
		c := name[index]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			out.WriteByte(c)
		}
	}
	return out.String()
}

// callTool runs one tool call and answers the JSON-RPC `result` body; nil when the tool is unknown
// (a tool failure is isError, not a JSON-RPC error).
func callTool(store *Store, name string, args map[string]any) []byte {
	bare := bareName(name)
	var canonical *toolSpec
	for index := range toolSpecs {
		folded := strings.ReplaceAll(toolSpecs[index].Name, "_", "")
		if bare == folded || strings.HasSuffix(bare, folded) {
			canonical = &toolSpecs[index]
			break
		}
	}
	if canonical == nil {
		return nil
	}
	full := stringArg(args, "full_name", "repo_full_name")
	owner := stringArg(args, "owner", "owner_login", "login")
	repo := stringArg(args, "repo", "repository", "repo_name")
	if strings.Contains(full, "/") {
		parts := strings.SplitN(full, "/", 2)
		if owner == "" {
			owner = parts[0]
		}
		if repo == "" {
			repo = parts[1]
		}
	}
	if owner == "" {
		owner = store.Viewer
	}

	switch canonical.Name {
	case "create_repo":
		repoName := stringArg(args, "name", "repo", "repository", "repo_name")
		if repoName == "" {
			return missingArgs([]string{"name"})
		}
		private, _ := args["private"].(bool)
		created := restCall(store, "POST", []string{"user", "repos"}, map[string]any{
			"name":        repoName,
			"description": stringArg(args, "description"),
			"private":     private,
		}, "")
		if created.Status == 201 {
			return okCall(created)
		}
		existing := restCall(store, "GET", []string{"repos", store.Viewer, repoName}, nil, "")
		if existing.Status == 200 {
			return okCall(existing)
		}
		return failedCall(created)

	case "get_repo":
		if repo == "" {
			return missingArgs([]string{"repo"})
		}
		reply := restCall(store, "GET", []string{"repos", owner, repo}, nil, "")
		if reply.Status == 200 {
			return okCall(reply)
		}
		return failedCall(reply)

	case "create_issue":
		title := stringArg(args, "title", "issue_title")
		var absent []string
		if repo == "" {
			absent = append(absent, "repo")
		}
		if title == "" {
			absent = append(absent, "title")
		}
		if len(absent) > 0 {
			return missingArgs(absent)
		}
		reply := restCall(store, "POST", []string{"repos", owner, repo, "issues"}, map[string]any{
			"title": title,
			"body":  stringArg(args, "body", "description"),
		}, "")
		if reply.Status == 201 {
			return okCall(reply)
		}
		return failedCall(reply)

	case "list_issues":
		if repo == "" {
			return missingArgs([]string{"repo"})
		}
		state := stringArg(args, "state", "status")
		if state == "" {
			state = "open"
		}
		reply := restCall(store, "GET", []string{"repos", owner, repo, "issues"}, nil, "state="+urlEscape(state)+"&per_page=100")
		if reply.Status == 200 {
			text := "[]"
			if reply.Body != nil {
				text = string(reply.Body)
			}
			return toolResult(text, nil, false)
		}
		return failedCall(reply)

	case "create_pull_request":
		title := stringArg(args, "title", "pr_title")
		head := stringArg(args, "head", "head_ref", "head_branch", "source")
		base := stringArg(args, "base", "base_ref", "base_branch", "target")
		var absent []string
		if repo == "" {
			absent = append(absent, "repo")
		}
		if title == "" {
			absent = append(absent, "title")
		}
		if head == "" {
			absent = append(absent, "head")
		}
		if base == "" {
			absent = append(absent, "base")
		}
		if len(absent) > 0 {
			return missingArgs(absent)
		}
		reply := restCall(store, "POST", []string{"repos", owner, repo, "pulls"}, map[string]any{
			"title": title,
			"body":  stringArg(args, "body"),
			"head":  head,
			"base":  base,
		}, "")
		if reply.Status == 201 {
			return okCall(reply)
		}
		return failedCall(reply)
	}

	number, hasNumber := numberArg(args, "pull_number", "pull_request_number", "pr_number", "number")
	var absent []string
	if repo == "" {
		absent = append(absent, "repo")
	}
	if !hasNumber {
		absent = append(absent, "pull_number")
	}
	if len(absent) > 0 {
		return missingArgs(absent)
	}
	reply := restCall(store, "PUT", []string{"repos", owner, repo, "pulls", strconv.Itoa(number), "merge"},
		map[string]any{"merge_method": "squash"}, "")
	if reply.Status == 200 {
		return okCall(reply)
	}
	return failedCall(reply)
}

// handleMcp serves one request to /mcp. authorized is whether the request carried a credential.
func handleMcp(store *Store, method string, authorized bool, body []byte) McpReply {
	if method == "DELETE" || method == "GET" {
		return McpReply{Status: 202}
	}
	if method != "POST" {
		return McpReply{Status: 405, Body: errorBody(nil, -32600, "the MCP endpoint takes POST")}
	}
	if !authorized {
		return McpReply{Status: 401, Body: errorBody(nil, -32001, "Requires authentication")}
	}

	parsed, ok := parseJSON(body)
	if !ok {
		return McpReply{Status: 400, Body: errorBody(nil, -32700, "Parse error")}
	}

	if batch, isBatch := parsed.([]any); isBatch {
		bodies := make([][]byte, 0, len(batch))
		for _, entry := range batch {
			if answer := dispatchMcp(store, entry); answer != nil {
				bodies = append(bodies, answer)
			}
		}
		if len(bodies) == 0 {
			return McpReply{Status: 202}
		}
		out := make([]byte, 0, 64)
		out = append(out, '[')
		for index, one := range bodies {
			if index > 0 {
				out = append(out, ',')
			}
			out = append(out, one...)
		}
		out = append(out, ']')
		return McpReply{Status: 200, Body: out}
	}

	answer := dispatchMcp(store, parsed)
	if answer == nil {
		return McpReply{Status: 202}
	}
	return McpReply{Status: 200, Body: answer}
}

func dispatchMcp(store *Store, message any) []byte {
	if !isJSONObj(message) {
		return errorBody(nil, -32600, "Invalid Request")
	}
	object := jsonObj(message)
	id, hasID := object["id"]
	method := jstr(object, "method", "")
	params := jsonObj(object["params"])
	if !hasID || id == nil {
		// A notification: nothing to answer.
		return nil
	}

	switch method {
	case "server/discover":
		return resultBody(id, discoverResult)
	case "initialize":
		asked := jstr(params, "protocolVersion", mcpVersions[0])
		version := mcpVersions[0]
		for _, known := range mcpVersions {
			if known == asked {
				version = asked
				break
			}
		}
		b := &jb{}
		b.openObject()
		b.str("protocolVersion", version)
		b.obj("capabilities")
		b.obj("tools")
		b.bool("listChanged", false)
		b.closeObject()
		b.closeObject()
		b.raw("serverInfo", []byte(serverInfoJSON))
		b.closeObject()
		return resultBody(id, b.buf)
	case "ping":
		return resultBody(id, []byte("{}"))
	case "tools/list":
		out := make([]byte, 0, len(toolsJSON)+16)
		out = append(out, `{"tools":`...)
		out = append(out, toolsJSON...)
		out = append(out, '}')
		return resultBody(id, out)
	case "resources/list":
		return resultBody(id, []byte(`{"resources":[]}`))
	case "prompts/list":
		return resultBody(id, []byte(`{"prompts":[]}`))
	case "tools/call":
		name := jstr(params, "name", "")
		args := jsonObj(params["arguments"])
		result := callTool(store, name, args)
		if result == nil {
			return errorBody(id, -32602, "Unknown tool "+jsonQuote(name))
		}
		return resultBody(id, result)
	}
	return errorBody(id, -32601, "Method not found: "+method)
}
