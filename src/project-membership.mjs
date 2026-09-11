function normalizedPath(value) {
  return typeof value === 'string' && value.startsWith('/') ? value.replace(/\/+$/, '') : '';
}

function containsPath(root, path) {
  return path === root || path.startsWith(`${root}/`);
}

function worktreeTail(path) {
  const match = /\/\.codex\/worktrees\/[^/]+\/(.+)$/.exec(path);
  return match?.[1]?.replace(/^\/+|\/+$/g, '') || '';
}

export function enrichThreadProjects(threads, projects) {
  const catalog = (projects || []).map(project => ({
    ...project,
    roots: (project?.roots || []).map(root => normalizedPath(typeof root === 'string' ? root : root?.path)).filter(Boolean),
  }));
  const byId = new Map(catalog.map(project => [project.id, project]));
  return (threads || []).map(thread => {
    const explicit = typeof thread?.projectId === 'string' && thread.projectId ? byId.get(thread.projectId) : null;
    const cwd = normalizedPath(thread?.cwd);
    let project = explicit;
    let source = explicit ? 'explicit' : null;
    if (!project && cwd) {
      const matches = catalog.flatMap(candidate => candidate.roots
        .map((root, rootIndex) => ({ candidate, root, rootIndex }))
        .filter(match => containsPath(match.root, cwd)))
        .sort((left, right) => right.root.length - left.root.length || left.rootIndex - right.rootIndex);
      if (matches.length) {
        project = matches[0].candidate;
        source = 'root';
      }
    }
    if (!project && cwd) {
      const tail = worktreeTail(cwd);
      if (tail) {
        const candidates = catalog.flatMap(candidate => candidate.roots
          .map((root, rootIndex) => ({ candidate, rootIndex, matches: root === tail || root.endsWith(`/${tail}`) }))
          .filter(match => match.matches));
        const bestRootIndex = Math.min(...candidates.map(match => match.rootIndex));
        const matches = candidates.filter(match => match.rootIndex === bestRootIndex).map(match => match.candidate);
        const ids = new Set(matches.map(candidate => candidate.id));
        if (ids.size === 1) {
          project = matches[0];
          source = 'worktree';
        }
      }
    }
    if (!project) return { ...thread, projectId: null, projectName: undefined, projectRoot: undefined, projectIdSource: null };
    return {
      ...thread,
      projectId: project.id,
      projectName: project.name,
      projectRoot: project.roots[0],
      projectIdSource: source,
    };
  });
}
