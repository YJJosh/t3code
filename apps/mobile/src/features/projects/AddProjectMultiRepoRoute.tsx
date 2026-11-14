import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectMultiRepoScreen } from "./AddProjectScreen";

type AddProjectMultiRepoRouteParams = {
  readonly environmentId?: string | string[];
  readonly sourceEnvironmentId?: string | string[];
  readonly sourceProjectId?: string | string[];
};

export function AddProjectMultiRepoRoute({
  route,
}: StaticScreenProps<AddProjectMultiRepoRouteParams | undefined>) {
  return <AddProjectMultiRepoScreen {...(route.params ?? {})} />;
}
