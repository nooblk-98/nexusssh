"use client";
import type { ReactNode } from "react";
export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}
