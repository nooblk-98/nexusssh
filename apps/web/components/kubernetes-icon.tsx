import type { SVGProps } from "react";

export function KubernetesIcon({
  size = 20,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <image href="/kubernetes.svg" width="24" height="24" />
    </svg>
  );
}
