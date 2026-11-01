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

export const useKubernetesImport = create<{ requested: boolean }>(() => ({
  requested: false,
}));

export function openKubernetesImport() {
  useKubernetesImport.setState({ requested: true });
  navigate("/settings/kubernetes");
}
