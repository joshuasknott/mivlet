import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { PluginDemo } from "./PluginDemo.jsx";
import "./plugins.css";

const apps = [
  { name: "Notion", file: "notion.svg" },
  { name: "Google Drive", file: "google-drive-color.png" },
  { name: "Gmail", file: "gmail-color.svg" },
  { name: "Google Calendar", file: "google-calendar-color.svg" },
  { name: "Linear", file: "linear.svg" },
  { name: "GitHub", file: "github.svg" },
  { name: "Figma", file: "figma-color.svg" },
  { name: "Canva", file: "canva.png" },
];

export function Plugins({ onReadBriefing, playbackEnabled }) {
  return (
    <section
      className="plugins-section"
      id="plugins"
      aria-labelledby="plugins-title"
    >
      <div className="plugins-intro">
        <div className="plugins-copy">
          <h2 id="plugins-title">
            Your apps.
            <br />
            Part of the conversation.
          </h2>
          <p>
            Plugins connect Mivlet to the tools you already use. Bring docs,
            conversations and projects into the work.
          </p>
          <p className="plugins-requirements">
            Each app needs its own connection and permissions. Availability
            depends on your setup.
          </p>
          <a className="plugins-example-link" href="#plugin-example">
            <span>See plugins in action</span> <ArrowRight size={20} />
          </a>
        </div>
        <ul
          className="plugin-apps"
          aria-label="Apps you can connect through plugins"
        >
          {apps.map((app, index) => (
            <li
              className="plugin-app"
              key={app.name}
              style={{ "--app-order": index }}
            >
              <img
                src={`/plugins/${app.file}`}
                alt=""
                width="56"
                height="56"
                loading="lazy"
              />
              <span>{app.name}</span>
            </li>
          ))}
        </ul>
      </div>
      <PluginDemo
        onReadBriefing={onReadBriefing}
        playbackEnabled={playbackEnabled}
      />
    </section>
  );
}
