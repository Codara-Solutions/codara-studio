import { useEffect, useState } from "react";
import packageJson from "../../../../package.json";

const APP_VERSION = packageJson.version as string;

export default function AboutSection() {
  const [platform, setPlatform] = useState<string>("");

  useEffect(() => {
    let alive = true;
    void window.spark.app.platform().then((p) => {
      if (alive) setPlatform(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">About</h2>
        <p className="settings-section-desc">Spark Agent — terminal multiplexer with orchestration.</p>
      </header>
      <dl className="settings-meta-grid">
        <dt>Version</dt>
        <dd>v{APP_VERSION}</dd>
        <dt>Platform</dt>
        <dd>{platform || "—"}</dd>
        <dt>App ID</dt>
        <dd>com.spark.agent</dd>
      </dl>
    </section>
  );
}
