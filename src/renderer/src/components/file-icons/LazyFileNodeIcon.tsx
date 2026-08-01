import React from "react";
import type { FileNodeIconProps } from "./FileNodeIcon";

const FileNodeIcon = React.lazy(() =>
  import("./FileNodeIcon").then((module) => ({
    default: module.FileNodeIcon,
  })),
);

export default function LazyFileNodeIcon(props: FileNodeIconProps) {
  const size = props.size ?? 14;
  return (
    <React.Suspense
      fallback={
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: size,
            height: size,
            flex: `0 0 ${size}px`,
          }}
        />
      }
    >
      <FileNodeIcon {...props} />
    </React.Suspense>
  );
}
