import { create } from "zustand";
import { navigate } from "./router";

export const useKubernetesImport = create<{ requested: boolean }>(() => ({
  requested: false,
}));

export function openKubernetesImport() {
  useKubernetesImport.setState({ requested: true });
  navigate("/settings/kubernetes");
}
