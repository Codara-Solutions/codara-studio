import { useEffect } from "react";
import { emitLocalToast } from "./local-toast";

// Once after Codara turned off drawing with the graphics card (a GPU crash or
// a run that did not exit cleanly, src/main/gpu-drawing.ts): one toast that
// says why, and main records it was shown so later starts stay quiet. Waits
// for `ready`: the toast host mounts only once the app has booted.
export function useGpuDrawingNotice(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void window.spark.gpuDrawing
      .status()
      .then((status) => {
        if (!live || !status?.notice) return;
        emitLocalToast(status.notice.title, status.notice.body, "warning");
        void window.spark.gpuDrawing.noticeShown().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ready]);
}
