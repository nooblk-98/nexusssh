"use client";
import { BookOpen, Bug, ExternalLink, Github, Tag } from "lucide-react";
import { project, VERSION } from "../../lib/app-info";
import { Logo } from "../ui";
import { PageHead } from "./page-head";

const resources = [
  {
    label: "Source code",
    description: "Browse the project and contribute on GitHub.",
    href: project.repository,
    icon: Github,
  },
  {
    label: "Documentation",
    description: "Setup, deployment, security, and usage guides.",
    href: `${project.repository}#readme`,
    icon: BookOpen,
  },
  {
    label: "Releases",
    description: "Published versions and release notes.",
    href: `${project.repository}/releases`,
    icon: Tag,
  },
  {
    label: "Report an issue",
    description: "Report a bug or suggest an improvement.",
    href: `${project.repository}/issues`,
    icon: Bug,
  },
];

export function About() {
  return (
    <div className="page about-page">
      <PageHead
        title="About"
        sub="Application details and project resources."
      />
      <section className="card card-pad about-summary" aria-label="NexusSSH">
        <div className="row">
          <Logo />
          <span className="badge blue">v{VERSION}</span>
        </div>
        <p>
          A self-hosted workspace for SSH terminals, SFTP file management, and
          remote access through MCP. Manage your servers, work with your team,
          and connect AI agents from one place.
        </p>
      </section>

      <section aria-labelledby="about-project">
        <h2 id="about-project">Project information</h2>
        <dl className="card card-pad about-details">
          <div>
            <dt>Version</dt>
            <dd>{VERSION}</dd>
          </div>
          <div>
            <dt>Developer</dt>
            <dd>
              <a
                href={project.developerProfile}
                target="_blank"
                rel="noopener noreferrer"
              >
                {project.developer}
              </a>
              <span className="small muted">@nooblk-98</span>
            </dd>
          </div>
          <div>
            <dt>Website</dt>
            <dd>
              <a
                href={project.developerWebsite}
                target="_blank"
                rel="noopener noreferrer"
              >
                www.itsnooblk.com
              </a>
            </dd>
          </div>
          <div>
            <dt>Repository</dt>
            <dd>
              <a
                href={project.repository}
                target="_blank"
                rel="noopener noreferrer"
              >
                nooblk-98/nexusssh
              </a>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="about-resources">
        <h2 id="about-resources">Resources &amp; support</h2>
        <div className="about-resources">
          {resources.map(({ label, description, href, icon: Icon }) => (
            <a
              key={label}
              className="card about-resource"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon size={20} aria-hidden="true" />
              <div className="grow">
                <h3>{label}</h3>
                <p>{description}</p>
              </div>
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
