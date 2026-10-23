import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  parseMultiRepoCloneInput,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("reads the repositories typed for a new multi-repo project", () => {
    expect(
      parseMultiRepoCloneInput(
        "acme/api, git@github.com:acme/web.git\n https://gitlab.com/other/API.git acme/api",
      ),
    ).toEqual({
      members: [
        { path: "api", remoteUrl: "https://github.com/acme/api.git" },
        { path: "web", remoteUrl: "git@github.com:acme/web.git" },
        { path: "API-2", remoteUrl: "https://gitlab.com/other/API.git" },
      ],
      invalid: [],
    });
    expect(parseMultiRepoCloneInput("/srv/git/api.git file:///tmp/web.git api")).toEqual({
      members: [],
      invalid: ["/srv/git/api.git", "file:///tmp/web.git", "api"],
    });
    expect(parseMultiRepoCloneInput("  ")).toEqual({ members: [], invalid: [] });
    // One repository written three ways is cloned once.
    expect(
      parseMultiRepoCloneInput(
        "acme/api https://github.com/acme/api git@github.com:Acme/api.git acme/web",
      ),
    ).toEqual({
      members: [
        { path: "api", remoteUrl: "https://github.com/acme/api.git" },
        { path: "web", remoteUrl: "https://github.com/acme/web.git" },
      ],
      invalid: [],
    });
  });

  it("allows hidden repository names but not Workler's reserved folders", () => {
    expect(parseMultiRepoCloneInput("acme/.github https://gitlab.com/acme/.config.git")).toEqual({
      members: [
        { path: ".github", remoteUrl: "https://github.com/acme/.github.git" },
        { path: ".config", remoteUrl: "https://gitlab.com/acme/.config.git" },
      ],
      invalid: [],
    });
    const reserved = [".git", ".worktrees", ".workler", ".", ".."].map(
      (name) => `https://github.com/acme/${name}`,
    );
    expect(parseMultiRepoCloneInput(reserved.join(" "))).toEqual({
      members: [],
      invalid: reserved,
    });
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});
