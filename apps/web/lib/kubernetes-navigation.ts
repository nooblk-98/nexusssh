import { create } from "zustand";
import { navigate } from "./router";
import { narrow, useWorkspace } from "./store";

export function connectCluster(cluster: { id: string; name: string }) {
  const workspace = useWorkspace.getState();
  workspace.open({
    kind: "kubernetes",
    serverId: cluster.id,
    title: cluster.name,
    status: "connecting",
  });
  if (narrow()) workspace.setCollapsed(true);
  navigate("/");
}

export const useKubernetesImport = create<{
  requested: boolean;
  groupId: string | null;
}>(() => ({
  requested: false,
  groupId: null,
}));

export function openKubernetesImport(groupId: string | null = null) {
  useKubernetesImport.setState({ requested: true, groupId });
  navigate("/settings/kubernetes");
}
