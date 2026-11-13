import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectMultiRepoScreen } from "./AddProjectScreen";

export function AddProjectMultiRepoRoute({
  route,
}: StaticScreenProps<{ readonly environmentId?: string | string[] } | undefined>) {
  return <AddProjectMultiRepoScreen {...(route.params ?? {})} />;
}
