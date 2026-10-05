import type { HostProcess } from "@pi-desktop/host-runtime";
export async function trustedNavigation(
  host: () => HostProcess,
  checkRoot: (path: string) => Promise<unknown>,
) {
  const [p, s] = await Promise.all([
    host().call<{
      projects: {
        id: number;
        name: string;
        path: string;
      }[];
    }>("projects.list", {}),
    host().call<{
      sessions: {
        id: string;
        title: string;
        projectPath?: string;
      }[];
    }>("session.list", {}),
  ]);
  const projects = [] as {
    id: string;
    name: string;
    path: string;
  }[];
  for (const row of p.projects) {
    try {
      await checkRoot(row.path);
      projects.push({ id: String(row.id), name: row.name, path: row.path });
    } catch (error) {
      if ((error as { code?: string }).code !== "PERMISSION_DENIED")
        throw error;
    }
  }
  return {
    projects: projects.map(({ path, ...row }) => row),
    sessions: s.sessions
      .filter(
        (row) =>
          row.projectPath && projects.some((p) => p.path === row.projectPath),
      )
      .map((row) => ({
        id: row.id,
        title: row.title,
        projectId: projects.find((p) => p.path === row.projectPath)?.id ?? null,
      })),
  };
}
