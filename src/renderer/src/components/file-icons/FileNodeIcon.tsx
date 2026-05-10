import React from "react";
import { fileIconUrl, folderIconUrl } from "./iconResolver";

type Props = {
  name: string;
  isDir: boolean;
  isOpen?: boolean;
  size?: number;
  opacity?: number;
};

/**
 * Catppuccin per-file/per-folder icon. Resolves the icon name from the
 * file or folder name, then renders it as an inline data: SVG so there are no
 * runtime fetches.
 */
export function FileNodeIcon({ name, isDir, isOpen = false, size = 14, opacity }: Props) {
  const url = isDir ? folderIconUrl(name, isOpen) : fileIconUrl(name);
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          style={{ display: "block", opacity }}
          draggable={false}
        />
      ) : null}
    </span>
  );
}
