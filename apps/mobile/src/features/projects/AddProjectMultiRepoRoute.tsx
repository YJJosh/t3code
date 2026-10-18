import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectMultiRepoCloneScreen, AddProjectMultiRepoScreen } from "./AddProjectScreen";

type AddProjectMultiRepoRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectMultiRepoRoute({
  route,
}: StaticScreenProps<AddProjectMultiRepoRouteParams | undefined>) {
  return <AddProjectMultiRepoScreen {...(route.params ?? {})} />;
}

type AddProjectMultiRepoCloneRouteParams = {
  readonly environmentId?: string | string[];
  readonly folder?: string | string[];
};

export function AddProjectMultiRepoCloneRoute({
  route,
}: StaticScreenProps<AddProjectMultiRepoCloneRouteParams | undefined>) {
  return <AddProjectMultiRepoCloneScreen {...(route.params ?? {})} />;
}
