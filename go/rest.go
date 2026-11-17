// The GitHub REST v3 surface, under /api/v3.
//
// Every reply is JSON; an error carries {"message": …}. Issue and pull-request bodies are
// serialized once and cached on the record, so the read benchmark's 2,000 GETs of one issue cost
// a map lookup and a socket write. A port of src/rest.ts.

package main

import (
	"sort"
	"strconv"
	"strings"
)

// hdr is one extra response header a route asks for.
type hdr struct {
	Name  string
	Value string
}

// ApiReply is one REST answer: a status and a JSON body (nil for 204).
type ApiReply struct {
	Status  int
	Body    []byte
	Headers []hdr
}

// ApiRequest is one REST request, already split and parsed.
type ApiRequest struct {
	Method string
	// Segments are the path pieces after /api/v3, each percent-decoded.
	Segments []string
	Query    string
	// JSON is the parsed body, nil when there was none.
	JSON any
	// BadJSON is set when a body was sent and did not parse.
	BadJSON    bool
	Authorized bool
	Host       string
}

const notFoundMessage = "Not Found"

func apiError(status int, message string) ApiReply {
	body := make([]byte, 0, len(message)+96)
	body = append(body, `{"message":`...)
	body = appendJSONString(body, message)
	body = append(body, `,"documentation_url":"https://docs.github.com/rest"}`...)
	return ApiReply{Status: status, Body: body}
}

func nodeID(kind string, id int) string {
	return base64Of([]byte(kind + ":" + strconv.Itoa(id)))
}

// parseIntPrefix reads the leading integer of text the way Number.parseInt does.
func parseIntPrefix(text string) (int, bool) {
	index := 0
	for index < len(text) && (text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r') {
		index++
	}
	negative := false
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		negative = text[index] == '-'
		index++
	}
	start := index
	value := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		value = value*10 + int(text[index]-'0')
		if value > 1<<40 {
			value = 1 << 40
		}
		index++
	}
	if index == start {
		return 0, false
	}
	if negative {
		return -value, true
	}
	return value, true
}

// intQuery answers a positive integer query parameter, or fallback.
func intQuery(query string, key string, fallback int) int {
	raw, held := queryGet(query, key)
	if !held {
		return fallback
	}
	parsed, ok := parseIntPrefix(raw)
	if !ok || parsed <= 0 {
		return fallback
	}
	return parsed
}

// ---------------------------------------------------------------- JSON views

func writeUser(b *jb, store *Store) {
	b.openObject()
	b.str("login", store.Viewer)
	b.num("id", store.ViewerID)
	b.str("node_id", nodeID("User", store.ViewerID))
	b.str("avatar_url", "")
	b.str("type", "User")
	b.bool("site_admin", false)
	b.str("html_url", "/"+store.Viewer)
	b.str("url", "/api/v3/users/"+store.Viewer)
	b.closeObject()
}

func repoJSON(store *Store, repo *RepoRec) []byte {
	if repo.JSON != nil {
		return repo.JSON
	}
	fullName := repo.Owner + "/" + repo.Name
	b := &jb{buf: make([]byte, 0, 1024)}
	b.openObject()
	b.num("id", repo.ID)
	b.str("node_id", nodeID("Repository", repo.ID))
	b.str("name", repo.Name)
	b.str("full_name", fullName)
	b.bool("private", repo.Private)
	b.key("owner")
	writeUser(b, store)
	b.str("html_url", "/"+fullName)
	b.str("url", "/api/v3/repos/"+fullName)
	b.str("description", repo.Description)
	b.bool("fork", false)
	b.str("created_at", epochISO)
	b.str("updated_at", epochISO)
	b.str("pushed_at", epochISO)
	b.str("git_url", "/"+fullName+".git")
	b.str("clone_url", "/"+fullName+".git")
	b.num("size", 0)
	b.num("stargazers_count", 0)
	b.num("watchers_count", 0)
	b.num("forks_count", 0)
	b.num("open_issues_count", len(repo.IssueOrder))
	b.str("default_branch", repo.DefaultBranch)
	if repo.Private {
		b.str("visibility", "private")
	} else {
		b.str("visibility", "public")
	}
	b.bool("has_issues", true)
	b.bool("has_projects", true)
	b.bool("has_wiki", true)
	b.bool("has_pages", false)
	b.bool("has_downloads", true)
	b.bool("archived", false)
	b.bool("disabled", false)
	b.bool("allow_squash_merge", true)
	b.bool("allow_merge_commit", true)
	b.bool("allow_rebase_merge", true)
	b.obj("permissions")
	b.bool("admin", true)
	b.bool("maintain", true)
	b.bool("push", true)
	b.bool("triage", true)
	b.bool("pull", true)
	b.closeObject()
	b.closeObject()
	repo.JSON = b.buf
	return repo.JSON
}

func writeLabel(b *jb, label *LabelRec) {
	b.openObject()
	b.num("id", label.ID)
	b.str("node_id", nodeID("Label", label.ID))
	b.str("name", label.Name)
	b.str("color", label.Color)
	b.bool("default", false)
	b.null("description")
	b.str("url", "")
	b.closeObject()
}

func issueJSON(store *Store, repo *RepoRec, issue *IssueRec) []byte {
	if issue.JSON != nil {
		return issue.JSON
	}
	fullName := repo.Owner + "/" + repo.Name
	number := strconv.Itoa(issue.Number)
	b := &jb{buf: make([]byte, 0, 1024+len(issue.Body)+len(issue.Title))}
	b.openObject()
	b.num("id", issue.ID)
	b.str("node_id", nodeID("Issue", issue.ID))
	b.num("number", issue.Number)
	b.str("title", issue.Title)
	b.str("body", issue.Body)
	b.str("state", issue.State)
	b.null("state_reason")
	b.bool("locked", false)
	b.arr("labels")
	for _, label := range issue.Labels {
		b.item()
		writeLabel(b, label)
	}
	b.closeArray()
	b.key("user")
	writeUser(b, store)
	b.null("assignee")
	b.arr("assignees")
	b.closeArray()
	b.null("milestone")
	b.num("comments", len(issue.Comments))
	b.str("created_at", epochISO)
	b.str("updated_at", epochISO)
	b.strOrNull("closed_at", epochISO, issue.State == "closed")
	b.str("html_url", "/"+fullName+"/issues/"+number)
	b.str("url", "/api/v3/repos/"+fullName+"/issues/"+number)
	b.str("repository_url", "/api/v3/repos/"+fullName)
	b.str("comments_url", "/api/v3/repos/"+fullName+"/issues/"+number+"/comments")
	b.str("author_association", "OWNER")
	b.closeObject()
	issue.JSON = b.buf
	return issue.JSON
}

func pullJSON(store *Store, repo *RepoRec, pull *PullRec) []byte {
	if pull.JSON != nil {
		return pull.JSON
	}
	fullName := repo.Owner + "/" + repo.Name
	number := strconv.Itoa(pull.Number)
	b := &jb{buf: make([]byte, 0, 1536)}
	b.openObject()
	b.num("id", pull.ID)
	b.str("node_id", nodeID("PullRequest", pull.ID))
	b.num("number", pull.Number)
	b.str("title", pull.Title)
	b.str("body", pull.Body)
	b.str("state", pull.State)
	b.bool("locked", false)
	b.bool("draft", false)
	b.bool("merged", pull.Merged)
	if pull.Merged {
		b.null("mergeable")
		b.str("mergeable_state", "unknown")
	} else {
		b.bool("mergeable", mergeableOf(repo, pull))
		b.str("mergeable_state", "clean")
	}
	b.strOrNull("merged_at", epochISO, pull.Merged)
	b.strOrNull("closed_at", epochISO, pull.State == "closed")
	b.str("created_at", epochISO)
	b.str("updated_at", epochISO)
	b.strOrNull("merge_commit_sha", pull.MergeCommitSha, pull.MergeCommitSha != "")
	b.key("user")
	writeUser(b, store)
	b.obj("head")
	b.str("label", repo.Owner+":"+pull.Head)
	b.str("ref", pull.Head)
	b.str("sha", pull.HeadSha)
	b.key("user")
	writeUser(b, store)
	b.null("repo")
	b.closeObject()
	b.obj("base")
	b.str("label", repo.Owner+":"+pull.Base)
	b.str("ref", pull.Base)
	b.str("sha", pull.BaseSha)
	b.key("user")
	writeUser(b, store)
	b.null("repo")
	b.closeObject()
	b.str("html_url", "/"+fullName+"/pull/"+number)
	b.str("url", "/api/v3/repos/"+fullName+"/pulls/"+number)
	b.num("comments", 0)
	b.num("commits", 1)
	b.num("additions", 0)
	b.num("deletions", 0)
	b.num("changed_files", 0)
	b.str("author_association", "OWNER")
	b.closeObject()
	pull.JSON = b.buf
	return pull.JSON
}

// mergeableOf reports whether a pull request still merges cleanly (GitHub's `mergeable`).
func mergeableOf(repo *RepoRec, pull *PullRec) bool {
	head := branchTip(repo, pull.Head)
	if head == "" {
		head = pull.HeadSha
	}
	base := branchTip(repo, pull.Base)
	if base == "" {
		base = pull.BaseSha
	}
	_, ok := planMerge(repo, head, base)
	return ok
}

// mergePlan is the tree a squash merge produces, and the two commits it joins.
type mergePlan struct {
	Tree string
	Base string
	Head string
}

func planMerge(repo *RepoRec, head string, base string) (mergePlan, bool) {
	headCommit := commitOf(repo.Objects, head)
	baseCommit := commitOf(repo.Objects, base)
	if headCommit == "" || baseCommit == "" {
		return mergePlan{}, false
	}
	ancestor := mergeBase(repo.Objects, headCommit, baseCommit)
	ancestorTree := ""
	if ancestor != "" {
		ancestorTree = treeOfCommit(repo.Objects, ancestor)
	}
	result := mergeTrees(repo.Objects, ancestorTree, treeOfCommit(repo.Objects, baseCommit), treeOfCommit(repo.Objects, headCommit))
	if result.Conflict || result.Tree == "" {
		return mergePlan{}, false
	}
	return mergePlan{Tree: result.Tree, Base: baseCommit, Head: headCommit}, true
}

// writeCommitBody writes the nested `commit` object of a commit view.
func writeCommitBody(b *jb, repo *RepoRec, parsed CommitView) {
	who := func() {
		b.openObject()
		b.str("name", repo.Owner)
		b.str("email", repo.Owner+"@example.invalid")
		b.str("date", epochISO)
		b.closeObject()
	}
	b.openObject()
	b.str("message", strings.TrimSuffix(parsed.Message, "\n"))
	b.key("author")
	who()
	b.key("committer")
	who()
	b.obj("tree")
	b.str("sha", parsed.Tree)
	b.closeObject()
	b.num("comment_count", 0)
	b.closeObject()
}

func writeCommit(b *jb, repo *RepoRec, oid string) {
	var parsed CommitView
	if object := repo.Objects[oid]; object != nil && object.Type == objCommit {
		parsed = parseCommit(object.Data)
	}
	fullName := repo.Owner + "/" + repo.Name
	b.openObject()
	b.str("sha", oid)
	b.str("node_id", nodeID("Commit", 1))
	b.key("commit")
	writeCommitBody(b, repo, parsed)
	b.null("author")
	b.null("committer")
	b.arr("parents")
	for _, parent := range parsed.Parents {
		b.item()
		b.openObject()
		b.str("sha", parent)
		b.closeObject()
	}
	b.closeArray()
	b.str("html_url", "/"+fullName+"/commit/"+oid)
	b.str("url", "/api/v3/repos/"+fullName+"/commits/"+oid)
	b.closeObject()
}

// ---------------------------------------------------------------- helpers

// resolveCommittish resolves a ref name or object id to a commit id.
func resolveCommittish(repo *RepoRec, ref string) string {
	if ref == "" {
		tip := branchTip(repo, repo.DefaultBranch)
		return tip
	}
	if branch, held := repo.Refs["refs/heads/"+ref]; held {
		return commitOf(repo.Objects, branch)
	}
	if tag, held := repo.Refs["refs/tags/"+ref]; held {
		return commitOf(repo.Objects, tag)
	}
	if direct, held := repo.Refs[ref]; held {
		return commitOf(repo.Objects, direct)
	}
	if isOid(ref) {
		if _, held := repo.Objects[ref]; held {
			return commitOf(repo.Objects, ref)
		}
	}
	return ""
}

func blobBytes(objects ObjectStore, oid string) []byte {
	if object := objects[oid]; object != nil {
		return object.Data
	}
	return nil
}

func lineCount(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	lines := 0
	for _, c := range data {
		if c == 0x0a {
			lines++
		}
	}
	if data[len(data)-1] != 0x0a {
		lines++
	}
	return lines
}

// ---------------------------------------------------------------- the router

// handleRest serves one /api/v3 request.
func handleRest(store *Store, request *ApiRequest) ApiReply {
	segments := request.Segments
	method := request.Method

	if len(segments) == 0 {
		b := &jb{}
		b.openObject()
		b.str("current_user_url", "/api/v3/user")
		b.str("current_user_repositories_url", "/api/v3/user/repos")
		b.str("repository_url", "/api/v3/repos/{owner}/{repo}")
		b.str("rate_limit_url", "/api/v3/rate_limit")
		b.str("user_repositories_url", "/api/v3/user/repos")
		b.str("graphql_url", "/api/graphql")
		b.closeObject()
		return ApiReply{Status: 200, Body: b.buf, Headers: []hdr{
			{"x-oauth-scopes", "repo, read:org, admin:org"},
			{"x-accepted-oauth-scopes", ""},
			{"x-github-media-type", "github.v3; format=json"},
		}}
	}

	if segments[0] == "meta" && len(segments) == 1 {
		b := &jb{}
		b.openObject()
		b.str("installed_version", "3.12.0")
		b.bool("verifiable_password_authentication", false)
		b.arr("packages")
		b.closeArray()
		b.arr("ssh_keys")
		b.closeArray()
		b.closeObject()
		return ApiReply{Status: 200, Body: b.buf}
	}

	if !request.Authorized {
		return apiError(401, "Requires authentication")
	}
	if request.BadJSON {
		return apiError(400, "Problems parsing JSON")
	}

	if segments[0] == "rate_limit" && len(segments) == 1 {
		core := func(b *jb) {
			b.openObject()
			b.num("limit", 5000)
			b.num("remaining", 5000)
			b.num("reset", 0)
			b.num("used", 0)
			b.closeObject()
		}
		b := &jb{}
		b.openObject()
		b.obj("resources")
		b.key("core")
		core(b)
		b.key("graphql")
		core(b)
		b.key("search")
		core(b)
		b.closeObject()
		b.key("rate")
		core(b)
		b.closeObject()
		return ApiReply{Status: 200, Body: b.buf}
	}

	if segments[0] == "user" {
		if len(segments) == 1 && method == "GET" {
			b := &jb{}
			writeUser(b, store)
			return ApiReply{Status: 200, Body: b.buf}
		}
		if len(segments) == 2 && segments[1] == "repos" {
			if method == "GET" {
				return listUserRepos(store, request)
			}
			if method == "POST" {
				return createUserRepo(store, request)
			}
			return apiError(404, notFoundMessage)
		}
		return apiError(404, notFoundMessage)
	}

	if segments[0] == "repos" {
		if len(segments) < 3 {
			return apiError(404, notFoundMessage)
		}
		owner := segments[1]
		name := segments[2]
		store.latchOwner(owner)
		repo := store.repo(owner, name)
		if repo == nil {
			return apiError(404, notFoundMessage)
		}
		return repoRoute(store, repo, segments[3:], request)
	}

	return apiError(404, notFoundMessage)
}

func listUserRepos(store *Store, request *ApiRequest) ApiReply {
	perPage := intQuery(request.Query, "per_page", 30)
	if perPage > 100 {
		perPage = 100
	}
	page := intQuery(request.Query, "page", 1)
	all := store.repoList()
	start := (page - 1) * perPage
	if start > len(all) {
		start = len(all)
	}
	end := start + perPage
	if end > len(all) {
		end = len(all)
	}
	b := &jb{buf: make([]byte, 0, 1024*(end-start+1))}
	b.openArray()
	for _, repo := range all[start:end] {
		b.itemRaw(repoJSON(store, repo))
	}
	b.closeArray()

	last := (len(all) + perPage - 1) / perPage
	if last < 1 {
		last = 1
	}
	url := func(target int) string {
		return "http://" + request.Host + "/api/v3/user/repos?per_page=" + strconv.Itoa(perPage) + "&page=" + strconv.Itoa(target)
	}
	var links []string
	if page < last {
		links = append(links, "<"+url(page+1)+`>; rel="next"`, "<"+url(last)+`>; rel="last"`)
	}
	if page > 1 {
		links = append(links, "<"+url(1)+`>; rel="first"`, "<"+url(page-1)+`>; rel="prev"`)
	}
	var headers []hdr
	if len(links) > 0 {
		headers = []hdr{{"link", strings.Join(links, ", ")}}
	}
	return ApiReply{Status: 200, Body: b.buf, Headers: headers}
}

func createUserRepo(store *Store, request *ApiRequest) ApiReply {
	body := jsonObj(request.JSON)
	name := jstr(body, "name", "")
	if name == "" {
		return apiError(422, "Repository creation failed: name is required")
	}
	if _, held := store.repos[name]; held {
		return apiError(422, "Repository creation failed: name already exists on this account")
	}
	private, _ := jboolOk(body, "private")
	repo := store.createRepo(name, RepoOptions{
		Description:   jstr(body, "description", ""),
		Private:       private,
		DefaultBranch: jstr(body, "default_branch", "main"),
	})
	if repo == nil {
		return apiError(422, "Repository creation failed: name already exists on this account")
	}
	if autoInit, _ := jboolOk(body, "auto_init"); autoInit {
		tree := putObject(repo.Objects, objTree, emptyTreeData)
		commitTree(store, repo, repo.DefaultBranch, tree, "Initial commit")
	}
	return ApiReply{Status: 201, Body: repoJSON(store, repo)}
}

func repoRoute(store *Store, repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	method := request.Method

	if len(rest) == 0 {
		switch method {
		case "GET":
			return ApiReply{Status: 200, Body: repoJSON(store, repo)}
		case "PATCH":
			body := jsonObj(request.JSON)
			if description, ok := jstrOk(body, "description"); ok {
				repo.Description = description
			}
			if private, ok := jboolOk(body, "private"); ok {
				repo.Private = private
			}
			if name, ok := jstrOk(body, "name"); ok && name != repo.Name {
				store.renameRepo(repo, name)
			}
			if branch, ok := jstrOk(body, "default_branch"); ok && branch != "" {
				repo.DefaultBranch = branch
			}
			repo.JSON = nil
			return ApiReply{Status: 200, Body: repoJSON(store, repo)}
		case "DELETE":
			store.deleteRepo(repo.Name)
			return ApiReply{Status: 204}
		}
		return apiError(404, notFoundMessage)
	}

	switch rest[0] {
	case "branches":
		return branchesRoute(repo, rest, method)
	case "commits":
		return commitsRoute(repo, rest, request)
	case "git":
		return gitDataRoute(repo, rest, request)
	case "contents":
		return contentsRoute(store, repo, rest[1:], request)
	case "labels":
		return labelsRoute(store, repo, rest, request)
	case "issues":
		return issuesRoute(store, repo, rest, request)
	case "pulls":
		return pullsRoute(store, repo, rest, request)
	case "collaborators":
		if method == "GET" {
			return ApiReply{Status: 200, Body: []byte("[]")}
		}
	}
	return apiError(404, notFoundMessage)
}

func branchesRoute(repo *RepoRec, rest []string, method string) ApiReply {
	if method != "GET" {
		return apiError(404, notFoundMessage)
	}
	if len(rest) == 1 {
		b := &jb{}
		b.openArray()
		for _, name := range branchNames(repo) {
			b.item()
			b.openObject()
			b.str("name", name)
			b.obj("commit")
			b.str("sha", branchTip(repo, name))
			b.str("url", "")
			b.closeObject()
			b.bool("protected", false)
			b.closeObject()
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}
	name := strings.Join(rest[1:], "/")
	tip := branchTip(repo, name)
	if tip == "" {
		return apiError(404, "Branch not found")
	}
	var parsed CommitView
	if object := repo.Objects[tip]; object != nil && object.Type == objCommit {
		parsed = parseCommit(object.Data)
	}
	b := &jb{}
	b.openObject()
	b.str("name", name)
	b.obj("commit")
	b.str("sha", tip)
	b.key("commit")
	writeCommitBody(b, repo, parsed)
	b.str("url", "")
	b.closeObject()
	b.bool("protected", false)
	b.obj("_links")
	b.closeObject()
	b.closeObject()
	return ApiReply{Status: 200, Body: b.buf}
}

func commitsRoute(repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	if request.Method != "GET" {
		return apiError(404, notFoundMessage)
	}
	if len(rest) >= 2 {
		oid := resolveCommittish(repo, strings.Join(rest[1:], "/"))
		if oid == "" {
			return apiError(404, "No commit found")
		}
		b := &jb{}
		writeCommit(b, repo, oid)
		return ApiReply{Status: 200, Body: b.buf}
	}
	ref, _ := queryGet(request.Query, "sha")
	tip := resolveCommittish(repo, ref)
	if tip == "" {
		return ApiReply{Status: 200, Body: []byte("[]")}
	}
	perPage := intQuery(request.Query, "per_page", 30)
	if perPage > 100 {
		perPage = 100
	}
	b := &jb{}
	b.openArray()
	for _, oid := range commitList(repo.Objects, []string{tip}, perPage) {
		b.item()
		writeCommit(b, repo, oid)
	}
	b.closeArray()
	return ApiReply{Status: 200, Body: b.buf}
}

func gitDataRoute(repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	if len(rest) < 2 {
		return apiError(404, notFoundMessage)
	}
	if rest[1] == "refs" {
		if request.Method == "POST" && len(rest) == 2 {
			body := jsonObj(request.JSON)
			ref := jstr(body, "ref", "")
			sha := jstr(body, "sha", "")
			if !strings.HasPrefix(ref, "refs/") || len(ref) < 6 {
				return apiError(422, "Reference name is not valid")
			}
			if _, held := repo.Objects[sha]; !isOid(sha) || !held {
				return apiError(422, "Object does not exist")
			}
			if _, held := repo.Refs[ref]; held {
				return apiError(422, "Reference already exists")
			}
			repo.Refs[ref] = sha
			touchGit(repo)
			b := &jb{}
			b.openObject()
			b.str("ref", ref)
			b.str("node_id", nodeID("Ref", 1))
			b.str("url", "")
			b.obj("object")
			b.str("sha", sha)
			b.str("type", "commit")
			b.str("url", "")
			b.closeObject()
			b.closeObject()
			return ApiReply{Status: 201, Body: b.buf}
		}
		wanted := "refs/" + strings.Join(rest[2:], "/")
		if request.Method == "GET" {
			sha, held := repo.Refs[wanted]
			if !held {
				return apiError(404, notFoundMessage)
			}
			typeName := "commit"
			if object := repo.Objects[sha]; object != nil {
				typeName = objTypeName[object.Type]
			}
			b := &jb{}
			b.openObject()
			b.str("ref", wanted)
			b.str("node_id", nodeID("Ref", 1))
			b.str("url", "")
			b.obj("object")
			b.str("sha", sha)
			b.str("type", typeName)
			b.str("url", "")
			b.closeObject()
			b.closeObject()
			return ApiReply{Status: 200, Body: b.buf}
		}
		if request.Method == "DELETE" {
			if _, held := repo.Refs[wanted]; !held {
				return apiError(404, notFoundMessage)
			}
			delete(repo.Refs, wanted)
			touchGit(repo)
			return ApiReply{Status: 204}
		}
		return apiError(404, notFoundMessage)
	}
	if rest[1] == "commits" && len(rest) == 3 && request.Method == "GET" {
		oid := rest[2]
		object := repo.Objects[oid]
		if object == nil || object.Type != objCommit {
			return apiError(404, notFoundMessage)
		}
		parsed := parseCommit(object.Data)
		b := &jb{}
		b.openObject()
		b.str("sha", oid)
		b.str("message", parsed.Message)
		b.obj("tree")
		b.str("sha", parsed.Tree)
		b.closeObject()
		b.arr("parents")
		for _, parent := range parsed.Parents {
			b.item()
			b.openObject()
			b.str("sha", parent)
			b.closeObject()
		}
		b.closeArray()
		b.closeObject()
		return ApiReply{Status: 200, Body: b.buf}
	}
	if rest[1] == "blobs" && len(rest) == 3 && request.Method == "GET" {
		oid := rest[2]
		object := repo.Objects[oid]
		if object == nil || object.Type != objBlob {
			return apiError(404, notFoundMessage)
		}
		b := &jb{}
		b.openObject()
		b.str("sha", oid)
		b.num("size", len(object.Data))
		b.str("encoding", "base64")
		b.str("content", base64Of(object.Data))
		b.closeObject()
		return ApiReply{Status: 200, Body: b.buf}
	}
	return apiError(404, notFoundMessage)
}

// ---------------------------------------------------------------- contents

func writeContentEntry(b *jb, repo *RepoRec, path string, oid string, withContent bool) {
	data := blobBytes(repo.Objects, oid)
	name := path
	if slash := strings.LastIndexByte(path, '/'); slash >= 0 {
		name = path[slash+1:]
	}
	fullName := repo.Owner + "/" + repo.Name
	b.openObject()
	b.str("type", "file")
	b.str("name", name)
	b.str("path", path)
	b.str("sha", oid)
	b.num("size", len(data))
	b.str("url", "/api/v3/repos/"+fullName+"/contents/"+path)
	b.str("html_url", "/"+fullName+"/blob/"+repo.DefaultBranch+"/"+path)
	b.str("git_url", "/api/v3/repos/"+fullName+"/git/blobs/"+oid)
	b.str("download_url", "/"+fullName+"/raw/"+path)
	b.str("encoding", "base64")
	b.obj("_links")
	b.closeObject()
	if withContent {
		b.str("content", base64Of(data))
	}
	b.closeObject()
}

func contentsRoute(store *Store, repo *RepoRec, pathSegments []string, request *ApiRequest) ApiReply {
	path := strings.Join(pathSegments, "/")
	method := request.Method

	if method == "GET" {
		ref, _ := queryGet(request.Query, "ref")
		commit := resolveCommittish(repo, ref)
		if commit == "" {
			return apiError(404, "This repository is empty.")
		}
		tree := treeOfCommit(repo.Objects, commit)
		if tree == "" {
			return apiError(404, notFoundMessage)
		}
		if path == "" {
			return ApiReply{Status: 200, Body: directoryListing(repo, tree, "")}
		}
		entry := treeLookup(repo.Objects, tree, splitPath(path))
		if entry == nil {
			return apiError(404, notFoundMessage)
		}
		if entry.Mode == "40000" {
			return ApiReply{Status: 200, Body: directoryListing(repo, entry.OID, path)}
		}
		b := &jb{}
		writeContentEntry(b, repo, path, entry.OID, true)
		return ApiReply{Status: 200, Body: b.buf}
	}

	if method == "PUT" || method == "DELETE" {
		if path == "" {
			return apiError(404, notFoundMessage)
		}
		body := jsonObj(request.JSON)
		branch := jstr(body, "branch", repo.DefaultBranch)
		tip := branchTip(repo, branch)
		tree := ""
		if tip != "" {
			tree = treeOfCommit(repo.Objects, tip)
		}
		segments := splitPath(path)
		var existing *TreeEntry
		if tree != "" {
			existing = treeLookup(repo.Objects, tree, segments)
		}
		givenSha := jstr(body, "sha", "")
		fallbackMessage := "Update file"
		if method == "DELETE" {
			fallbackMessage = "Delete file"
		}
		message := jstr(body, "message", fallbackMessage)

		if method == "DELETE" {
			if existing == nil {
				return apiError(404, notFoundMessage)
			}
			if givenSha != "" && givenSha != existing.OID {
				return apiError(409, "sha does not match")
			}
			newTree := treeWithoutPath(repo.Objects, tree, segments)
			if newTree == "" {
				return apiError(404, notFoundMessage)
			}
			commit := commitTree(store, repo, branch, newTree, message)
			b := &jb{}
			b.openObject()
			b.null("content")
			b.obj("commit")
			b.str("sha", commit)
			b.str("node_id", nodeID("Commit", 1))
			b.str("message", message)
			b.obj("tree")
			b.str("sha", newTree)
			b.closeObject()
			b.arr("parents")
			if tip != "" {
				b.item()
				b.openObject()
				b.str("sha", tip)
				b.closeObject()
			}
			b.closeArray()
			b.closeObject()
			b.closeObject()
			return ApiReply{Status: 200, Body: b.buf}
		}

		encoding := jstr(body, "encoding", "base64")
		raw := jstr(body, "content", "")
		var data []byte
		if encoding == "base64" {
			data = base64Decode(raw)
		} else {
			data = []byte(raw)
		}
		if givenSha != "" {
			if existing == nil {
				return apiError(404, notFoundMessage)
			}
			if givenSha != existing.OID {
				return apiError(409, path+" does not match "+givenSha)
			}
		}
		blob := putObject(repo.Objects, objBlob, data)
		newTree := treeWithPath(repo.Objects, tree, segments, blob, "100644")
		commit := commitTree(store, repo, branch, newTree, message)
		status := 200
		if existing == nil {
			status = 201
		}
		b := &jb{}
		b.openObject()
		b.key("content")
		writeContentEntry(b, repo, path, blob, false)
		b.obj("commit")
		b.str("sha", commit)
		b.str("node_id", nodeID("Commit", 1))
		b.str("message", message)
		b.obj("tree")
		b.str("sha", newTree)
		b.closeObject()
		b.arr("parents")
		if tip != "" {
			b.item()
			b.openObject()
			b.str("sha", tip)
			b.closeObject()
		}
		b.closeArray()
		b.str("html_url", "")
		b.str("url", "")
		b.closeObject()
		b.closeObject()
		return ApiReply{Status: status, Body: b.buf}
	}

	return apiError(404, notFoundMessage)
}

// directoryListing answers one directory's own entries (never recursive).
func directoryListing(repo *RepoRec, treeOid string, prefix string) []byte {
	b := &jb{}
	b.openArray()
	object := repo.Objects[treeOid]
	if object != nil && object.Type == objTree {
		for _, entry := range parseTree(object.Data) {
			path := entry.Name
			if prefix != "" {
				path = prefix + "/" + entry.Name
			}
			if entry.Mode == "40000" {
				b.item()
				b.openObject()
				b.str("type", "dir")
				b.str("name", entry.Name)
				b.str("path", path)
				b.str("sha", entry.OID)
				b.num("size", 0)
				b.str("url", "")
				b.str("html_url", "")
				b.str("git_url", "")
				b.null("download_url")
				b.obj("_links")
				b.closeObject()
				b.closeObject()
			} else {
				b.item()
				writeContentEntry(b, repo, path, entry.OID, false)
			}
		}
	}
	b.closeArray()
	return b.buf
}

// ---------------------------------------------------------------- labels

func labelsRoute(store *Store, repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	if len(rest) == 1 && request.Method == "GET" {
		b := &jb{}
		b.openArray()
		for _, name := range repo.LabelOrder {
			b.item()
			writeLabel(b, repo.Labels[name])
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}
	if len(rest) == 1 && request.Method == "POST" {
		body := jsonObj(request.JSON)
		name := jstr(body, "name", "")
		if name == "" {
			return apiError(422, "Validation Failed: name is required")
		}
		if _, held := repo.Labels[name]; held {
			return apiError(422, "Validation Failed: label already exists")
		}
		label := &LabelRec{ID: store.nextID(), Name: name, Color: jstr(body, "color", "ededed")}
		repo.Labels[name] = label
		repo.LabelOrder = append(repo.LabelOrder, name)
		b := &jb{}
		writeLabel(b, label)
		return ApiReply{Status: 201, Body: b.buf}
	}
	if len(rest) == 2 && request.Method == "GET" {
		label := repo.Labels[rest[1]]
		if label == nil {
			return apiError(404, notFoundMessage)
		}
		b := &jb{}
		writeLabel(b, label)
		return ApiReply{Status: 200, Body: b.buf}
	}
	return apiError(404, notFoundMessage)
}

// ---------------------------------------------------------------- issues

// labelNameOf reads a label out of a `labels` array entry, which may be a string or an object.
func labelNameOf(entry any) string {
	if text, ok := entry.(string); ok {
		return text
	}
	return jstr(jsonObj(entry), "name", "")
}

// IssueInput names what creating an issue needs.
type IssueInput struct {
	Title  string
	Body   string
	Labels []any
}

// createIssue opens one issue; a label the repository does not hold is a 422.
func createIssue(store *Store, repo *RepoRec, input IssueInput) ApiReply {
	if input.Title == "" {
		return apiError(422, "Validation Failed: title is required")
	}
	labels := make([]*LabelRec, 0, len(input.Labels))
	for _, entry := range input.Labels {
		name := labelNameOf(entry)
		label := repo.Labels[name]
		if label == nil {
			return apiError(422, "Validation Failed: label "+jsonQuote(name)+" does not exist")
		}
		labels = append(labels, label)
	}
	number := repo.NextNumber
	repo.NextNumber++
	issue := &IssueRec{
		ID:     store.nextID(),
		Number: number,
		Title:  input.Title,
		Body:   input.Body,
		State:  "open",
		Labels: labels,
	}
	repo.Issues[number] = issue
	repo.IssueOrder = append(repo.IssueOrder, number)
	repo.JSON = nil
	return ApiReply{Status: 201, Body: issueJSON(store, repo, issue)}
}

func issuesRoute(store *Store, repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	method := request.Method
	if len(rest) == 1 {
		if method == "POST" {
			body := jsonObj(request.JSON)
			return createIssue(store, repo, IssueInput{
				Title:  jstr(body, "title", ""),
				Body:   jstr(body, "body", ""),
				Labels: jsonArr(body["labels"]),
			})
		}
		if method != "GET" {
			return apiError(404, notFoundMessage)
		}
		state, held := queryGet(request.Query, "state")
		if !held {
			state = "open"
		}
		direction, held := queryGet(request.Query, "direction")
		if !held {
			direction = "desc"
		}
		perPage := intQuery(request.Query, "per_page", 30)
		if perPage > 100 {
			perPage = 100
		}
		page := intQuery(request.Query, "page", 1)
		numbers := repo.IssueOrder
		if state != "all" {
			filtered := make([]int, 0, len(numbers))
			for _, number := range numbers {
				if repo.Issues[number].State == state {
					filtered = append(filtered, number)
				}
			}
			numbers = filtered
		}
		ordered := numbers
		if direction != "asc" {
			ordered = make([]int, len(numbers))
			for index, number := range numbers {
				ordered[len(numbers)-1-index] = number
			}
		}
		start := (page - 1) * perPage
		if start > len(ordered) {
			start = len(ordered)
		}
		end := start + perPage
		if end > len(ordered) {
			end = len(ordered)
		}
		b := &jb{}
		b.openArray()
		for _, number := range ordered[start:end] {
			b.itemRaw(issueJSON(store, repo, repo.Issues[number]))
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}

	number, numberOk := parseIntPrefix(rest[1])
	var issue *IssueRec
	if numberOk {
		issue = repo.Issues[number]
	}

	if len(rest) == 2 {
		if issue == nil {
			return apiError(404, notFoundMessage)
		}
		if method == "GET" {
			return ApiReply{Status: 200, Body: issueJSON(store, repo, issue)}
		}
		if method == "PATCH" {
			body := jsonObj(request.JSON)
			if title, ok := jstrOk(body, "title"); ok {
				issue.Title = title
			}
			if text, ok := jstrOk(body, "body"); ok {
				issue.Body = text
			}
			if state, ok := jstrOk(body, "state"); ok && (state == "closed" || state == "open") {
				issue.State = state
			}
			if list := jsonArr(body["labels"]); list != nil {
				labels := make([]*LabelRec, 0, len(list))
				for _, entry := range list {
					name := labelNameOf(entry)
					label := repo.Labels[name]
					if label == nil {
						return apiError(422, "Validation Failed: label "+jsonQuote(name)+" does not exist")
					}
					labels = append(labels, label)
				}
				issue.Labels = labels
			}
			issue.JSON = nil
			return ApiReply{Status: 200, Body: issueJSON(store, repo, issue)}
		}
		return apiError(404, notFoundMessage)
	}

	if len(rest) == 3 && rest[2] == "comments" {
		if issue == nil {
			return apiError(404, notFoundMessage)
		}
		if method == "GET" {
			b := &jb{}
			b.openArray()
			for _, comment := range issue.Comments {
				b.itemRaw(comment.JSON)
			}
			b.closeArray()
			return ApiReply{Status: 200, Body: b.buf}
		}
		if method == "POST" {
			body := jsonObj(request.JSON)
			comment := addComment(store, repo, issue, jstr(body, "body", ""))
			return ApiReply{Status: 201, Body: comment.JSON}
		}
		return apiError(404, notFoundMessage)
	}

	if len(rest) == 3 && rest[2] == "labels" && method == "POST" {
		if issue == nil {
			return apiError(404, notFoundMessage)
		}
		body := jsonObj(request.JSON)
		for _, entry := range jsonArr(body["labels"]) {
			name := labelNameOf(entry)
			label := repo.Labels[name]
			if label == nil {
				return apiError(422, "Validation Failed: label "+jsonQuote(name)+" does not exist")
			}
			already := false
			for _, held := range issue.Labels {
				if held.Name == name {
					already = true
					break
				}
			}
			if !already {
				issue.Labels = append(issue.Labels, label)
			}
		}
		issue.JSON = nil
		b := &jb{}
		b.openArray()
		for _, label := range issue.Labels {
			b.item()
			writeLabel(b, label)
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}

	return apiError(404, notFoundMessage)
}

// addComment adds one comment to an issue and answers the record (its JSON is built once).
func addComment(store *Store, repo *RepoRec, issue *IssueRec, body string) *CommentRec {
	id := store.nextID()
	fullName := repo.Owner + "/" + repo.Name
	number := strconv.Itoa(issue.Number)
	b := &jb{}
	b.openObject()
	b.num("id", id)
	b.str("node_id", nodeID("IssueComment", id))
	b.str("body", body)
	b.key("user")
	writeUser(b, store)
	b.str("created_at", epochISO)
	b.str("updated_at", epochISO)
	b.str("html_url", "/"+fullName+"/issues/"+number+"#issuecomment-"+strconv.Itoa(id))
	b.str("url", "/api/v3/repos/"+fullName+"/issues/comments/"+strconv.Itoa(id))
	b.str("issue_url", "/api/v3/repos/"+fullName+"/issues/"+number)
	b.str("author_association", "OWNER")
	b.closeObject()
	comment := &CommentRec{ID: id, Body: body, JSON: b.buf}
	issue.Comments = append(issue.Comments, comment)
	issue.JSON = nil
	return comment
}

// ---------------------------------------------------------------- pull requests

// PullInput names what opening a pull request needs.
type PullInput struct {
	Title string
	Body  string
	Head  string
	Base  string
}

// createPull opens one pull request; an unknown head or base branch is a 422.
func createPull(store *Store, repo *RepoRec, input PullInput) ApiReply {
	head := input.Head
	if colon := strings.LastIndexByte(head, ':'); colon >= 0 {
		head = head[colon+1:]
	}
	base := input.Base
	headSha := branchTip(repo, head)
	baseSha := branchTip(repo, base)
	if headSha == "" {
		return apiError(422, "Validation Failed: head "+jsonQuote(head)+" does not exist")
	}
	if baseSha == "" {
		return apiError(422, "Validation Failed: base "+jsonQuote(base)+" does not exist")
	}
	number := repo.NextNumber
	repo.NextNumber++
	pull := &PullRec{
		ID:      store.nextID(),
		Number:  number,
		Title:   input.Title,
		Body:    input.Body,
		State:   "open",
		Head:    head,
		Base:    base,
		HeadSha: headSha,
		BaseSha: baseSha,
	}
	repo.Pulls[number] = pull
	repo.PullOrder = append(repo.PullOrder, number)
	return ApiReply{Status: 201, Body: pullJSON(store, repo, pull)}
}

// mergePull merges one pull request as a squash commit on its base branch.
func mergePull(store *Store, repo *RepoRec, pull *PullRec) ApiReply {
	if pull.State == "closed" || pull.Merged {
		return apiError(405, "Pull Request is not mergeable")
	}
	head := branchTip(repo, pull.Head)
	if head == "" {
		head = pull.HeadSha
	}
	base := branchTip(repo, pull.Base)
	if base == "" {
		base = pull.BaseSha
	}
	plan, ok := planMerge(repo, head, base)
	if !ok {
		return apiError(405, "Pull Request is not mergeable")
	}
	message := pull.Title + " (#" + strconv.Itoa(pull.Number) + ")"
	if pull.Body != "" {
		message += "\n\n" + pull.Body
	}
	sha := commitTree(store, repo, pull.Base, plan.Tree, message)
	pull.Merged = true
	pull.State = "closed"
	pull.MergeCommitSha = sha
	pull.JSON = nil
	b := &jb{}
	b.openObject()
	b.str("sha", sha)
	b.bool("merged", true)
	b.str("message", "Pull Request successfully merged")
	b.closeObject()
	return ApiReply{Status: 200, Body: b.buf}
}

func pullFiles(repo *RepoRec, pull *PullRec) []byte {
	headRef := branchTip(repo, pull.Head)
	if headRef == "" {
		headRef = pull.HeadSha
	}
	baseRef := branchTip(repo, pull.Base)
	if baseRef == "" {
		baseRef = pull.BaseSha
	}
	head := commitOf(repo.Objects, headRef)
	base := commitOf(repo.Objects, baseRef)
	b := &jb{}
	b.openArray()
	if head == "" {
		b.closeArray()
		return b.buf
	}
	ancestor := ""
	if base != "" {
		ancestor = mergeBase(repo.Objects, head, base)
	}
	ancestorTree := ""
	if ancestor != "" {
		ancestorTree = treeOfCommit(repo.Objects, ancestor)
	}
	before := flattenTree(repo.Objects, ancestorTree, "", nil)
	after := flattenTree(repo.Objects, treeOfCommit(repo.Objects, head), "", nil)
	paths := make(map[string]struct{}, len(before)+len(after))
	for path := range before {
		paths[path] = struct{}{}
	}
	for path := range after {
		paths[path] = struct{}{}
	}
	ordered := make([]string, 0, len(paths))
	for path := range paths {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	for _, path := range ordered {
		old, hadOld := before[path]
		now, hasNow := after[path]
		if hadOld && hasNow && old.OID == now.OID {
			continue
		}
		status := "modified"
		additions := 0
		deletions := 0
		atLeastOne := func(n int) int {
			if n < 1 {
				return 1
			}
			return n
		}
		switch {
		case !hadOld && hasNow:
			status = "added"
			additions = atLeastOne(lineCount(blobBytes(repo.Objects, now.OID)))
		case hadOld && !hasNow:
			status = "removed"
			deletions = atLeastOne(lineCount(blobBytes(repo.Objects, old.OID)))
		case hadOld && hasNow:
			additions = atLeastOne(lineCount(blobBytes(repo.Objects, now.OID)))
			deletions = atLeastOne(lineCount(blobBytes(repo.Objects, old.OID)))
		}
		sha := ""
		if hasNow {
			sha = now.OID
		} else if hadOld {
			sha = old.OID
		}
		b.item()
		b.openObject()
		b.str("sha", sha)
		b.str("filename", path)
		b.str("status", status)
		b.num("additions", additions)
		b.num("deletions", deletions)
		b.num("changes", additions+deletions)
		b.str("blob_url", "")
		b.str("raw_url", "")
		b.str("contents_url", "/api/v3/repos/"+repo.Owner+"/"+repo.Name+"/contents/"+path)
		b.closeObject()
	}
	b.closeArray()
	return b.buf
}

func pullsRoute(store *Store, repo *RepoRec, rest []string, request *ApiRequest) ApiReply {
	method := request.Method
	if len(rest) == 1 {
		if method == "POST" {
			body := jsonObj(request.JSON)
			return createPull(store, repo, PullInput{
				Title: jstr(body, "title", ""),
				Body:  jstr(body, "body", ""),
				Head:  jstr(body, "head", ""),
				Base:  jstr(body, "base", ""),
			})
		}
		if method != "GET" {
			return apiError(404, notFoundMessage)
		}
		state, held := queryGet(request.Query, "state")
		if !held {
			state = "open"
		}
		perPage := intQuery(request.Query, "per_page", 30)
		if perPage > 100 {
			perPage = 100
		}
		page := intQuery(request.Query, "page", 1)
		numbers := repo.PullOrder
		if state != "all" {
			filtered := make([]int, 0, len(numbers))
			for _, number := range numbers {
				if repo.Pulls[number].State == state {
					filtered = append(filtered, number)
				}
			}
			numbers = filtered
		}
		start := (page - 1) * perPage
		if start > len(numbers) {
			start = len(numbers)
		}
		end := start + perPage
		if end > len(numbers) {
			end = len(numbers)
		}
		b := &jb{}
		b.openArray()
		for _, number := range numbers[start:end] {
			b.itemRaw(pullJSON(store, repo, repo.Pulls[number]))
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}

	number, numberOk := parseIntPrefix(rest[1])
	var pull *PullRec
	if numberOk {
		pull = repo.Pulls[number]
	}

	if len(rest) == 2 {
		if pull == nil {
			return apiError(404, notFoundMessage)
		}
		if method == "GET" {
			return ApiReply{Status: 200, Body: pullJSON(store, repo, pull)}
		}
		if method == "PATCH" {
			body := jsonObj(request.JSON)
			if title, ok := jstrOk(body, "title"); ok {
				pull.Title = title
			}
			if text, ok := jstrOk(body, "body"); ok {
				pull.Body = text
			}
			if state, ok := jstrOk(body, "state"); ok && (state == "closed" || state == "open") {
				pull.State = state
			}
			pull.JSON = nil
			return ApiReply{Status: 200, Body: pullJSON(store, repo, pull)}
		}
		return apiError(404, notFoundMessage)
	}

	if len(rest) == 3 && rest[2] == "files" && method == "GET" {
		if pull == nil {
			return apiError(404, notFoundMessage)
		}
		return ApiReply{Status: 200, Body: pullFiles(repo, pull)}
	}

	if len(rest) == 3 && rest[2] == "merge" {
		if pull == nil {
			return apiError(404, notFoundMessage)
		}
		if method == "PUT" {
			return mergePull(store, repo, pull)
		}
		if method == "GET" {
			if pull.Merged {
				return ApiReply{Status: 204}
			}
			return apiError(404, notFoundMessage)
		}
		return apiError(404, notFoundMessage)
	}

	if len(rest) == 3 && rest[2] == "commits" && method == "GET" {
		if pull == nil {
			return apiError(404, notFoundMessage)
		}
		headRef := branchTip(repo, pull.Head)
		if headRef == "" {
			headRef = pull.HeadSha
		}
		head := commitOf(repo.Objects, headRef)
		b := &jb{}
		b.openArray()
		if head != "" {
			for _, oid := range commitList(repo.Objects, []string{head}, 20) {
				b.item()
				writeCommit(b, repo, oid)
			}
		}
		b.closeArray()
		return ApiReply{Status: 200, Body: b.buf}
	}

	return apiError(404, notFoundMessage)
}
