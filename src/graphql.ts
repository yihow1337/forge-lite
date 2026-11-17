// The GraphQL v4 surface: a small parser and executor over a hand-written schema, enough for the
// documents gh and github-mcp-server send, plus the `__type` introspection they feature-detect with.

import { branchTip, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { addComment, createIssue, createPull, mergePull, mergeableOf } from './rest.ts';
import { commitOf, flattenTree, mergeBase, treeOfCommit } from './git/objects.ts';

// ---------------------------------------------------------------- the document parser

interface Token {
  kind: 'name' | 'punct' | 'int' | 'float' | 'string';
  value: string;
}

class VarRef {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }
}

interface AstField {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, unknown>;
  selections: AstNode[];
}

interface AstSpread {
  kind: 'spread';
  typeCondition: string | null;
  fragment: string | null;
  selections: AstNode[];
}

type AstNode = AstField | AstSpread;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: AstNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, AstSpread>;
}

const PUNCTUATORS = ['...', '(', ')', '{', '}', '[', ']', ':', '=', '$', '!', '@', '|', '&'];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === '﻿') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      if (text.startsWith('"""', index)) {
        const end = text.indexOf('"""', index + 3);
        const stop = end < 0 ? text.length : end;
        tokens.push({ kind: 'string', value: text.slice(index + 3, stop) });
        index = stop + 3;
        continue;
      }
      let out = '';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          const next = text[index + 1] as string;
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === 'u') {
            out += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
            index += 4;
          } else out += next;
          index += 2;
          continue;
        }
        out += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let end = index + 1;
      let float = false;
      while (end < text.length && /[0-9.eE+-]/.test(text[end] as string)) {
        if (text[end] === '.' || text[end] === 'e' || text[end] === 'E') float = true;
        end += 1;
      }
      tokens.push({ kind: float ? 'float' : 'int', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = index + 1;
      while (end < text.length && /[_0-9A-Za-z]/.test(text[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: text.slice(index, end) });
      index = end;
      continue;
    }
    const punct = PUNCTUATORS.find((candidate) => text.startsWith(candidate, index));
    if (punct === undefined) throw new Error(`unexpected character ${JSON.stringify(ch)} in the document`);
    tokens.push({ kind: 'punct', value: punct });
    index += punct.length;
  }
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private at: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.at = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('the document ended early');
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expect(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected ${JSON.stringify(value)} in the document`);
    this.at += 1;
  }

  /** Parse the whole document: its operations and its named fragments. */
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, AstSpread>();
    while (this.peek() !== undefined) {
      if (this.isPunct('{')) {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.next();
      if (keyword.kind !== 'name') throw new Error(`unexpected token ${JSON.stringify(keyword.value)}`);
      if (keyword.value === 'fragment') {
        const name = this.next().value;
        this.next();
        const typeName = this.next().value;
        fragments.set(name, { kind: 'spread', typeCondition: typeName, fragment: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword.value !== 'query' && keyword.value !== 'mutation' && keyword.value !== 'subscription') {
        throw new Error(`unknown operation ${JSON.stringify(keyword.value)}`);
      }
      let name: string | null = null;
      const after = this.peek();
      if (after !== undefined && after.kind === 'name') name = this.next().value;
      if (this.isPunct('(')) this.skipVariableDefinitions();
      this.skipDirectives();
      operations.push({ type: keyword.value, name, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.next();
      if (this.isPunct('(')) this.skipVariableDefinitions();
    }
  }

  private parseSelectionSet(): AstNode[] {
    this.expect('{');
    const nodes: AstNode[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        const token = this.peek();
        if (token !== undefined && token.kind === 'name' && token.value === 'on') {
          this.next();
          const typeName = this.next().value;
          this.skipDirectives();
          nodes.push({ kind: 'spread', typeCondition: typeName, fragment: null, selections: this.parseSelectionSet() });
          continue;
        }
        if (token !== undefined && token.kind === 'name') {
          this.next();
          this.skipDirectives();
          nodes.push({ kind: 'spread', typeCondition: null, fragment: token.value, selections: [] });
          continue;
        }
        this.skipDirectives();
        nodes.push({ kind: 'spread', typeCondition: null, fragment: null, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') throw new Error(`expected a field name, got ${JSON.stringify(first.value)}`);
      let alias = first.value;
      let name = first.value;
      if (this.isPunct(':')) {
        this.next();
        name = this.next().value;
      }
      const args: Record<string, unknown> = {};
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const key = this.next().value;
          this.expect(':');
          args[key] = this.parseValue();
        }
        this.next();
      }
      this.skipDirectives();
      const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
      nodes.push({ kind: 'field', name, alias, args, selections });
    }
    this.next();
    return nodes;
  }

  private parseValue(): unknown {
    if (this.isPunct('$')) {
      this.next();
      return new VarRef(this.next().value);
    }
    if (this.isPunct('[')) {
      this.next();
      const list: unknown[] = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.next();
      return list;
    }
    if (this.isPunct('{')) {
      this.next();
      const out: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const key = this.next().value;
        this.expect(':');
        out[key] = this.parseValue();
      }
      this.next();
      return out;
    }
    const token = this.next();
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'string') return token.value;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return token.value;
  }
}

/** Substitute the request's variables into a parsed argument value. */
function bind(value: unknown, variables: Record<string, unknown>): unknown {
  if (value instanceof VarRef) return variables[value.name] ?? null;
  if (Array.isArray(value)) return value.map((item) => bind(item, variables));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = bind(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- global ids

function encodeId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split('\u0001');
  } catch {
    return [];
  }
}

function repoGid(repo: RepoRec): string {
  return encodeId(`R\u0001${repo.name}`);
}

function issueGid(repo: RepoRec, issue: IssueRec): string {
  return encodeId(`I\u0001${repo.name}\u0001${issue.number}`);
}

function pullGid(repo: RepoRec, pull: PullRec): string {
  return encodeId(`P\u0001${repo.name}\u0001${pull.number}`);
}

function commentGid(repo: RepoRec, issueNumber: number, id: number): string {
  return encodeId(`C\u0001${repo.name}\u0001${issueNumber}\u0001${id}`);
}

// ---------------------------------------------------------------- the schema's sources

type Source = Record<string, unknown>;

function userSource(store: Store): Source {
  return {
    __typename: 'User',
    id: encodeId(`U\u0001${store.viewer}`),
    login: store.viewer,
    name: store.viewer,
    email: '',
    url: `/${store.viewer}`,
    avatarUrl: '',
    databaseId: store.viewerId,
  };
}

function issueSource(store: Store, repo: RepoRec, issue: IssueRec): Source {
  return {
    __typename: 'Issue',
    id: issueGid(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyText: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    closed: issue.state === 'closed',
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    author: () => userSource(store),
    labels: () => ({ __typename: 'LabelConnection', totalCount: issue.labels.length, nodes: issue.labels.map((label) => ({ __typename: 'Label', id: encodeId(`L\u0001${label.id}`), name: label.name, color: label.color })) }),
    comments: () => ({
      __typename: 'IssueCommentConnection',
      totalCount: issue.comments.length,
      nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: commentGid(repo, issue.number, comment.id), body: comment.body, author: () => userSource(store) })),
    }),
    repository: () => repositorySource(store, repo),
    assignees: () => ({ __typename: 'UserConnection', totalCount: 0, nodes: [] }),
    milestone: null,
  };
}

function pullSource(store: Store, repo: RepoRec, pull: PullRec): Source {
  return {
    __typename: 'PullRequest',
    id: pullGid(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    closed: pull.state === 'closed',
    isDraft: false,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: pull.merged ? 'UNKNOWN' : mergeableOf(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    author: () => userSource(store),
    repository: () => repositorySource(store, repo),
    files: (args: Record<string, unknown>) => {
      const paths = changedPaths(repo, pull);
      const first = typeof args.first === 'number' ? args.first : paths.length;
      const page = paths.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        totalCount: paths.length,
        nodes: page.map((path) => ({ __typename: 'PullRequestChangedFile', path, additions: 1, deletions: 0, changeType: 'ADDED' })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < paths.length, endCursor: page.length === 0 ? null : encodeId(`c\u0001${page.length - 1}`) },
      };
    },
  };
}

/** The paths a pull request changes, read from the git trees between its merge base and its head. */
function changedPaths(repo: RepoRec, pull: PullRec): string[] {
  const objects = repo.objects;
  const headCommit = commitOf(objects, branchTip(repo, pull.head) ?? pull.headSha);
  const baseCommit = commitOf(objects, branchTip(repo, pull.base) ?? pull.baseSha);
  if (headCommit === null) return [];
  const ancestor = baseCommit === null ? null : mergeBase(objects, headCommit, baseCommit);
  const before = flattenTree(objects, ancestor === null ? null : treeOfCommit(objects, ancestor));
  const after = flattenTree(objects, treeOfCommit(objects, headCommit));
  const paths: string[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined || old.oid !== entry.oid) paths.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) paths.push(path);
  paths.sort();
  return paths;
}

interface ConnectionArgs {
  first?: number;
  last?: number;
  after?: string | null;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

function connection(typeName: string, nodes: Source[], args: ConnectionArgs): Source {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const parts = decodeId(args.after);
    const index = Number.parseInt(parts[1] ?? '', 10);
    if (Number.isFinite(index)) start = index + 1;
  }
  const size = typeof args.first === 'number' && args.first > 0 ? args.first : nodes.length;
  const page = nodes.slice(start, start + size);
  const endIndex = start + page.length - 1;
  return {
    __typename: typeName,
    totalCount: nodes.length,
    nodes: page,
    edges: page.map((node, offset) => ({ __typename: 'Edge', cursor: encodeId(`c\u0001${start + offset}`), node })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < nodes.length,
      hasPreviousPage: start > 0,
      endCursor: page.length === 0 ? null : encodeId(`c\u0001${endIndex}`),
      startCursor: page.length === 0 ? null : encodeId(`c\u0001${start}`),
    },
  };
}

function repositorySource(store: Store, repo: RepoRec): Source {
  return {
    __typename: 'Repository',
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `/${repo.owner}/${repo.name}`,
    isPrivate: repo.private,
    isArchived: false,
    isFork: false,
    hasIssuesEnabled: true,
    hasWikiEnabled: true,
    hasProjectsEnabled: true,
    viewerPermission: 'ADMIN',
    viewerCanAdminister: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    owner: () => userSource(store),
    defaultBranchRef: () => {
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return { __typename: 'Ref', id: encodeId(`F\u0001${repo.name}\u0001${repo.defaultBranch}`), name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip, id: encodeId(`O\u0001${tip}`) } };
    },
    issue: (args: Record<string, unknown>) => {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueSource(store, repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      const connectionArgs = args as ConnectionArgs;
      const states = Array.isArray(connectionArgs.states) ? connectionArgs.states.map((state) => String(state).toUpperCase()) : null;
      let numbers = repo.issueOrder.filter((number) => {
        if (states === null) return true;
        const issue = repo.issues.get(number) as IssueRec;
        return states.includes(issue.state === 'closed' ? 'CLOSED' : 'OPEN');
      });
      const direction = connectionArgs.orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
      numbers = direction === 'DESC' ? [...numbers].sort((a, b) => b - a) : [...numbers].sort((a, b) => a - b);
      return connection('IssueConnection', numbers.map((number) => issueSource(store, repo, repo.issues.get(number) as IssueRec)), connectionArgs);
    },
    pullRequest: (args: Record<string, unknown>) => {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullSource(store, repo, pull);
    },
    pullRequests: (args: Record<string, unknown>) => {
      const connectionArgs = args as ConnectionArgs;
      const states = Array.isArray(connectionArgs.states) ? connectionArgs.states.map((state) => String(state).toUpperCase()) : null;
      const numbers = repo.pullOrder.filter((number) => {
        if (states === null) return true;
        const pull = repo.pulls.get(number) as PullRec;
        return states.includes(pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN');
      });
      return connection('PullRequestConnection', numbers.map((number) => pullSource(store, repo, repo.pulls.get(number) as PullRec)), connectionArgs);
    },
    labels: () => connection('LabelConnection', [...repo.labels.values()].map((label) => ({ __typename: 'Label', id: encodeId(`L\u0001${label.id}`), name: label.name, color: label.color })), {}),
    ref: (args: Record<string, unknown>) => {
      const qualified = String(args.qualifiedName ?? '');
      const name = qualified.startsWith('refs/heads/') ? qualified.slice('refs/heads/'.length) : qualified;
      const tip = branchTip(repo, name);
      if (tip === undefined) return null;
      return { __typename: 'Ref', id: encodeId(`F\u0001${repo.name}\u0001${name}`), name, target: { __typename: 'Commit', oid: tip } };
    },
  };
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'closePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'isPrivate', 'isArchived', 'isFork',
    'defaultBranchRef', 'viewerPermission', 'viewerCanAdminister', 'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'ref', 'refs', 'createdAt', 'updatedAt', 'stargazerCount',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'url', 'author', 'labels', 'comments', 'assignees', 'milestone', 'repository', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'closed', 'isDraft', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'files', 'commits', 'author', 'repository', 'url', 'createdAt', 'updatedAt', 'reviews', 'comments',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'author', 'committedDate', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'bodyText', 'author', 'createdAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  CommentAuthorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'],
};

const INPUT_TYPES: Readonly<Record<string, readonly string[]>> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'labelIds', 'assigneeIds', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'commitBody', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
};

function typeSource(name: string): Source | null {
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  const inputs = INPUT_TYPES[name];
  if (fields === undefined && enums === undefined && inputs === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enums !== undefined ? 'ENUM' : inputs !== undefined ? 'INPUT_OBJECT' : 'OBJECT',
    description: null,
    fields: () => (fields === undefined ? null : fields.map((field) => ({ __typename: '__Field', name: field, description: null, isDeprecated: false, deprecationReason: null, args: [] }))),
    enumValues: () => (enums === undefined ? null : enums.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null }))),
    inputFields: () => (inputs === undefined ? null : inputs.map((field) => ({ __typename: '__InputValue', name: field, description: null }))),
    interfaces: [],
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------- roots

function lookupNode(store: Store, id: string): Source | null {
  const parts = decodeId(id);
  const kind = parts[0];
  if (kind === 'R') {
    const repo = store.repos.get(parts[1] ?? '');
    return repo === undefined ? null : repositorySource(store, repo);
  }
  if (kind === 'I') {
    const repo = store.repos.get(parts[1] ?? '');
    const issue = repo?.issues.get(Number.parseInt(parts[2] ?? '', 10));
    return repo === undefined || issue === undefined ? null : issueSource(store, repo, issue);
  }
  if (kind === 'P') {
    const repo = store.repos.get(parts[1] ?? '');
    const pull = repo?.pulls.get(Number.parseInt(parts[2] ?? '', 10));
    return repo === undefined || pull === undefined ? null : pullSource(store, repo, pull);
  }
  if (kind === 'U') return userSource(store);
  return null;
}

function queryRoot(store: Store): Source {
  return {
    __typename: 'Query',
    viewer: () => userSource(store),
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.repo(owner, name);
      return repo === undefined ? null : repositorySource(store, repo);
    },
    node: (args: Record<string, unknown>) => lookupNode(store, String(args.id ?? '')),
    nodes: (args: Record<string, unknown>) => (Array.isArray(args.ids) ? args.ids.map((id) => lookupNode(store, String(id))) : []),
    rateLimit: { __typename: 'RateLimit', limit: 5000, remaining: 5000, cost: 1, resetAt: '2025-01-01T00:00:00Z' },
    __type: (args: Record<string, unknown>) => typeSource(String(args.name ?? '')),
    __schema: {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: Object.keys(TYPE_FIELDS).map((name) => typeSource(name)),
      directives: [],
    },
  };
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : args;
}

interface MutationFailure {
  message: string;
}

function mutationRoot(store: Store, errors: MutationFailure[]): Source {
  const repoOf = (id: string): RepoRec | null => {
    const parts = decodeId(id);
    if (parts[0] !== 'R') return null;
    return store.repos.get(parts[1] ?? '') ?? null;
  };
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const repo = repoOf(String(input.repositoryId ?? ''));
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return null;
      }
      const result = createIssue(store, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if (result.status !== 201) {
        errors.push({ message: 'Could not create the issue.' });
        return null;
      }
      const issue = repo.issues.get(repo.nextNumber - 1) as IssueRec;
      return { __typename: 'CreateIssuePayload', issue: issueSource(store, repo, issue), clientMutationId: null };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const parts = decodeId(String(input.issueId ?? ''));
      const repo = parts[0] === 'I' ? store.repos.get(parts[1] ?? '') : undefined;
      const issue = repo?.issues.get(Number.parseInt(parts[2] ?? '', 10));
      if (repo === undefined || issue === undefined) {
        errors.push({ message: 'Could not resolve to an Issue with the given id.' });
        return null;
      }
      issue.state = 'closed';
      issue.json = null;
      return { __typename: 'CloseIssuePayload', issue: issueSource(store, repo, issue), clientMutationId: null };
    },
    reopenIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const parts = decodeId(String(input.issueId ?? ''));
      const repo = parts[0] === 'I' ? store.repos.get(parts[1] ?? '') : undefined;
      const issue = repo?.issues.get(Number.parseInt(parts[2] ?? '', 10));
      if (repo === undefined || issue === undefined) return null;
      issue.state = 'open';
      issue.json = null;
      return { __typename: 'ReopenIssuePayload', issue: issueSource(store, repo, issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const repo = repoOf(String(input.repositoryId ?? ''));
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return null;
      }
      const result = createPull(store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (result.status !== 201) {
        errors.push({ message: 'Could not create the pull request.' });
        return null;
      }
      const pull = repo.pulls.get(repo.nextNumber - 1) as PullRec;
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(store, repo, pull), clientMutationId: null };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const parts = decodeId(String(input.pullRequestId ?? ''));
      const repo = parts[0] === 'P' ? store.repos.get(parts[1] ?? '') : undefined;
      const pull = repo?.pulls.get(Number.parseInt(parts[2] ?? '', 10));
      if (repo === undefined || pull === undefined) {
        errors.push({ message: 'Could not resolve to a PullRequest with the given id.' });
        return null;
      }
      const result = mergePull(store, repo, pull);
      if (result.status !== 200) {
        errors.push({ message: 'Pull Request is not mergeable.' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(store, repo, pull), clientMutationId: null };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const parts = decodeId(String(input.subjectId ?? ''));
      const repo = parts[0] === 'I' ? store.repos.get(parts[1] ?? '') : undefined;
      const issue = repo?.issues.get(Number.parseInt(parts[2] ?? '', 10));
      if (repo === undefined || issue === undefined) {
        errors.push({ message: 'Could not resolve to a subject with the given id.' });
        return null;
      }
      const comment = addComment(store, repo, issue, String(input.body ?? ''));
      const node = { __typename: 'IssueComment', id: commentGid(repo, issue.number, comment.id), body: comment.body, author: () => userSource(store), createdAt: '2025-01-01T00:00:00Z' };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', cursor: encodeId('c\u00010'), node }, subject: issueSource(store, repo, issue), clientMutationId: null };
    },
  };
}

// ---------------------------------------------------------------- execution

interface ExecError {
  message: string;
}

function resolveSelection(source: Source, nodes: readonly AstNode[], variables: Record<string, unknown>, errors: ExecError[], fragments: Map<string, AstSpread>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of nodes) {
    if (node.kind === 'spread') {
      const target = node.fragment === null ? node : fragments.get(node.fragment);
      if (target === undefined) continue;
      if (target.typeCondition !== null && target.typeCondition !== source.__typename) continue;
      Object.assign(out, resolveSelection(source, target.selections, variables, errors, fragments));
      continue;
    }
    if (node.name === '__typename') {
      out[node.alias] = source.__typename;
      continue;
    }
    if (!(node.name in source)) {
      errors.push({ message: `Field '${node.name}' doesn't exist on type '${String(source.__typename)}'` });
      out[node.alias] = null;
      continue;
    }
    const slot = source[node.name];
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.args)) args[key] = bind(value, variables);
    const value = typeof slot === 'function' ? (slot as (a: Record<string, unknown>) => unknown)(args) : slot;
    out[node.alias] = applyValue(value, node, variables, errors, fragments);
  }
  return out;
}

function applyValue(value: unknown, node: AstField, variables: Record<string, unknown>, errors: ExecError[], fragments: Map<string, AstSpread>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => applyValue(item, node, variables, errors, fragments));
  if (node.selections.length === 0) return typeof value === 'object' ? null : value;
  if (typeof value !== 'object') return null;
  return resolveSelection(value as Source, node.selections, variables, errors, fragments);
}

/** One GraphQL request's answer body. */
export interface GraphQLAnswer {
  data: Record<string, unknown> | null;
  errors?: ExecError[];
}

/** Run one operation document against the store. */
export function executeGraphQL(store: Store, body: unknown): GraphQLAnswer {
  const request = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = typeof request.variables === 'object' && request.variables !== null ? (request.variables as Record<string, unknown>) : {};
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  if (query.trim() === '') return { data: null, errors: [{ message: 'No query string was present' }] };

  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const operation = operationName === null ? document.operations[0] : document.operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) return { data: null, errors: [{ message: 'The document holds no operation to run' }] };

  const errors: ExecError[] = [];
  const root = operation.type === 'mutation' ? mutationRoot(store, errors) : queryRoot(store);
  let data: Record<string, unknown>;
  try {
    data = resolveSelection(root, operation.selections, variables, errors, document.fragments);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (errors.length > 0) return { data: null, errors };
  return { data };
}
