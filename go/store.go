// The forge's whole state: repositories, their git objects and refs, and the issues, labels,
// comments and pull requests the REST, GraphQL and MCP surfaces all read and write.
//
// Everything lives in memory and nothing reads a clock: ids are counters and timestamps are a
// fixed epoch plus a counter, so two runs of the same request sequence leave the same state.
// A port of src/store.ts; the JS Maps whose insertion order the surfaces read back are carried
// here as a map plus an explicit order slice.

package main

import "sort"

// epochSec is the timestamp every generated object and JSON date derives from (2025-01-01T00:00:00Z).
const epochSec = int64(1735689600)

// epochISO is the ISO form of epochSec, the created_at every object reports.
const epochISO = "2025-01-01T00:00:00Z"

// LabelRec is one repository label.
type LabelRec struct {
	ID    int
	Name  string
	Color string
}

// CommentRec is one issue comment; its REST body is built once, when it is created.
type CommentRec struct {
	ID   int
	Body string
	JSON []byte
}

// IssueRec is one issue. JSON is the cached REST body, cleared by every mutation.
type IssueRec struct {
	ID       int
	Number   int
	Title    string
	Body     string
	State    string
	Labels   []*LabelRec
	Comments []*CommentRec
	JSON     []byte
}

// PullRec is one pull request.
type PullRec struct {
	ID             int
	Number         int
	Title          string
	Body           string
	State          string
	Head           string
	Base           string
	HeadSha        string
	BaseSha        string
	Merged         bool
	MergeCommitSha string
	JSON           []byte
}

// cacheEntriesMax is how many built git answers one repository keeps. A cache key carries what
// the client asked for, so the number of distinct keys at one repository version is the client's
// to choose, and each value is a whole packfile. The benchmark's clones repeat one key and the
// conformance checks use a few dozen; this ceiling bounds what varied traffic can cost.
const cacheEntriesMax = 64

// RepoRec is one repository.
type RepoRec struct {
	ID            int
	Name          string
	Owner         string
	Description   string
	Private       bool
	DefaultBranch string

	Objects ObjectStore
	Refs    map[string]string

	Labels     map[string]*LabelRec
	LabelOrder []string

	Issues     map[int]*IssueRec
	IssueOrder []int

	Pulls     map[int]*PullRec
	PullOrder []int

	NextNumber int

	// Version is bumped by every change to refs or objects; the git answer cache is emptied with it.
	Version int

	cache     map[string][]byte
	cacheKeys []string

	// JSON is the cached REST body of the repository itself.
	JSON []byte

	// sortedRefs is the advertisement's ref order, rebuilt when the refs change.
	sortedRefs    []string
	sortedVersion int
	sortedValid   bool
}

// Store is one forge: one user and the repositories that user owns.
type Store struct {
	Viewer   string
	ViewerID int

	ownerLatched bool

	repos     map[string]*RepoRec
	repoOrder []string

	nextRepoID   int
	nextObjectID int
	commitSeq    int
}

func newStore(viewer string) *Store {
	return &Store{
		Viewer:       viewer,
		ViewerID:     1000,
		repos:        make(map[string]*RepoRec),
		nextRepoID:   5000,
		nextObjectID: 1,
	}
}

// latchOwner takes the first owner a request names as the token's own login. The scenario's
// viewer is the default, so a forge that is never asked still answers with the right login.
func (s *Store) latchOwner(owner string) {
	if s.ownerLatched {
		return
	}
	s.ownerLatched = true
	if owner == "" || owner == s.Viewer {
		return
	}
	s.Viewer = owner
	for _, repo := range s.repos {
		repo.Owner = owner
		repo.JSON = nil
	}
}

// owns reports whether owner is the login this token owns (another login owns nothing here).
func (s *Store) owns(owner string) bool {
	return owner == s.Viewer
}

// nextID answers the next id for an issue, comment, label or pull request (one space, as GitHub has).
func (s *Store) nextID() int {
	s.nextObjectID++
	return s.nextObjectID
}

// nextCommitTime answers a fresh, strictly increasing commit timestamp.
func (s *Store) nextCommitTime() int64 {
	s.commitSeq++
	return epochSec + int64(s.commitSeq)
}

// repo answers the repository, or nil; owner must be the viewer.
func (s *Store) repo(owner string, name string) *RepoRec {
	if !s.owns(owner) {
		return nil
	}
	return s.repos[name]
}

// repoList answers every repository in creation order.
func (s *Store) repoList() []*RepoRec {
	out := make([]*RepoRec, 0, len(s.repoOrder))
	for _, name := range s.repoOrder {
		if repo := s.repos[name]; repo != nil {
			out = append(out, repo)
		}
	}
	return out
}

// RepoOptions names what a repository is created with.
type RepoOptions struct {
	Description   string
	Private       bool
	DefaultBranch string
}

// createRepo makes a repository; nil when the name is taken.
func (s *Store) createRepo(name string, options RepoOptions) *RepoRec {
	if _, held := s.repos[name]; held {
		return nil
	}
	s.nextRepoID++
	branch := options.DefaultBranch
	if branch == "" {
		branch = "main"
	}
	repo := &RepoRec{
		ID:            s.nextRepoID,
		Name:          name,
		Owner:         s.Viewer,
		Description:   options.Description,
		Private:       options.Private,
		DefaultBranch: branch,
		Objects:       make(ObjectStore),
		Refs:          make(map[string]string),
		Labels:        make(map[string]*LabelRec),
		Issues:        make(map[int]*IssueRec),
		Pulls:         make(map[int]*PullRec),
		NextNumber:    1,
		cache:         make(map[string][]byte),
	}
	s.repos[name] = repo
	s.repoOrder = append(s.repoOrder, name)
	return repo
}

// deleteRepo drops a repository; whether it was there.
func (s *Store) deleteRepo(name string) bool {
	if _, held := s.repos[name]; !held {
		return false
	}
	delete(s.repos, name)
	for index, held := range s.repoOrder {
		if held == name {
			s.repoOrder = append(s.repoOrder[:index], s.repoOrder[index+1:]...)
			break
		}
	}
	return true
}

// renameRepo moves a repository to a new name, keeping the JS Map's "delete then set" ordering.
func (s *Store) renameRepo(repo *RepoRec, name string) {
	s.deleteRepo(repo.Name)
	repo.Name = name
	s.repos[name] = repo
	s.repoOrder = append(s.repoOrder, name)
}

// touchGit marks a repository's git state changed: the advertisement and pack caches are dropped.
func touchGit(repo *RepoRec) {
	repo.Version++
	repo.sortedValid = false
	if len(repo.cache) > 0 {
		repo.cache = make(map[string][]byte)
		repo.cacheKeys = repo.cacheKeys[:0]
	}
}

// cachedAnswer answers a built git reply for key, building it once per repository version.
func cachedAnswer(repo *RepoRec, key string, build func() []byte) []byte {
	if hit, held := repo.cache[key]; held {
		return hit
	}
	built := build()
	if len(repo.cacheKeys) >= cacheEntriesMax {
		// Drop the coldest key rather than letting varied traffic grow the heap without bound.
		coldest := repo.cacheKeys[0]
		repo.cacheKeys = repo.cacheKeys[1:]
		delete(repo.cache, coldest)
	}
	repo.cache[key] = built
	repo.cacheKeys = append(repo.cacheKeys, key)
	return built
}

// addObject stores one object in a repository.
func addObject(repo *RepoRec, typ int, data []byte) string {
	return putObject(repo.Objects, typ, data)
}

// branchTip answers the tip of a branch, or "".
func branchTip(repo *RepoRec, branch string) string {
	return repo.Refs["refs/heads/"+branch]
}

// branchNames answers every branch name, the default branch first and the rest in name order.
func branchNames(repo *RepoRec) []string {
	names := make([]string, 0, len(repo.Refs))
	for ref := range repo.Refs {
		if len(ref) > 11 && ref[:11] == "refs/heads/" {
			names = append(names, ref[11:])
		}
	}
	sort.Strings(names)
	for index, name := range names {
		if name == repo.DefaultBranch {
			copy(names[1:index+1], names[:index])
			names[0] = name
			break
		}
	}
	return names
}

// refNames answers every ref name in byte order, cached against the repository's version.
func refNames(repo *RepoRec) []string {
	if repo.sortedValid && repo.sortedVersion == repo.Version {
		return repo.sortedRefs
	}
	names := make([]string, 0, len(repo.Refs))
	for name := range repo.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	repo.sortedRefs = names
	repo.sortedVersion = repo.Version
	repo.sortedValid = true
	return names
}

// commitTree commits tree onto branch (creating it when it has no tip) and answers the new commit id.
func commitTree(store *Store, repo *RepoRec, branch string, tree string, message string) string {
	parent := branchTip(repo, branch)
	var parents []string
	if parent != "" {
		parents = []string{parent}
	}
	commit := buildCommit(BuildCommitFields{
		Tree:      tree,
		Parents:   parents,
		Message:   message,
		Timestamp: store.nextCommitTime(),
	})
	oid := addObject(repo, objCommit, commit)
	repo.Refs["refs/heads/"+branch] = oid
	touchGit(repo)
	return oid
}
