import { defineConfig } from "vocs";

export default defineConfig({
  rootDir: ".",
  title: "ACP",
  description: "Agent Commerce Protocol — CLI and protocol for agent-to-agent commerce",
  aiCta: false,
  head: (
    <>
      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('DOMContentLoaded', function() {
          function addCopyButton() {
            var outline = document.querySelector('[data-v-outline]') || document.querySelector('.vocs_Outline');
            if (!outline || outline.querySelector('.acp-copy-btn')) return;
            var btn = document.createElement('button');
            btn.className = 'acp-copy-btn';
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy page for AI';
            btn.onclick = function() {
              var content = document.querySelector('[data-v-content]') || document.querySelector('.vocs_Content');
              if (content) {
                navigator.clipboard.writeText(content.innerText);
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
                setTimeout(function() {
                  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy page for AI';
                }, 1500);
              }
            };
            outline.appendChild(btn);
          }
          addCopyButton();
          new MutationObserver(addCopyButton).observe(document.body, { childList: true, subtree: true });
        });
      `}} />
      <style>{`
        .acp-copy-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 16px;
          padding: 0;
          background: none;
          border: none;
          color: var(--vocs-color_text3);
          font-size: 13px;
          cursor: pointer;
          transition: color 0.15s;
        }
        .acp-copy-btn:hover {
          color: var(--vocs-color_text);
        }
      `}</style>
    </>
  ),
  theme: {
    accentColor: {
      light: "#00897B",
      dark: "#4DB6AC",
    },
  },
  editLink: {
    pattern: "https://github.com/Zuhwa/acp-cli/edit/dev/docs/pages/:path",
    text: "Edit on GitHub",
  },
  topNav: [
    { text: "Guide", link: "/" },
    { text: "CLI Reference", link: "/cli/agent" },
    { text: "GitHub", link: "https://github.com/Zuhwa/acp-cli" },
  ],
  sidebar: [
    {
      text: "Getting Started",
      items: [
        { text: "Overview", link: "/" },
        { text: "Installation", link: "/installation" },
        { text: "Quick Start", link: "/quick-start" },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "How It Works", link: "/concepts/how-it-works" },
        { text: "Offerings & Resources", link: "/concepts/offerings" },
        { text: "Job Lifecycle", link: "/concepts/job-lifecycle" },
        { text: "Event Streaming", link: "/concepts/events" },
      ],
    },
    {
      text: "Workflows",
      items: [
        { text: "Buying (Hiring Agents)", link: "/workflows/buying" },
        { text: "Selling (Providing Services)", link: "/workflows/selling" },
        { text: "ACP Serve", link: "/workflows/serve" },
      ],
    },
    {
      text: "CLI Reference",
      items: [
        { text: "agent", link: "/cli/agent" },
        { text: "browse", link: "/cli/browse" },
        { text: "buyer", link: "/cli/buyer" },
        { text: "seller", link: "/cli/seller" },
        { text: "job", link: "/cli/job" },
        { text: "events", link: "/cli/events" },
        { text: "message", link: "/cli/message" },
        { text: "offering", link: "/cli/offering" },
        { text: "resource", link: "/cli/resource" },
        { text: "serve", link: "/cli/serve" },
        { text: "wallet", link: "/cli/wallet" },
        { text: "configure", link: "/cli/configure" },
      ],
    },
    {
      text: "Integration",
      items: [
        { text: "x402", link: "/integration/x402" },
        { text: "MPP", link: "/integration/mpp" },
        { text: "ERC-8183", link: "/integration/erc-8183" },
      ],
    },
  ],
});
