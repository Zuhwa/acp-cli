import { defineConfig } from "vocs";

export default defineConfig({
  title: "ACP — Agent Commerce Protocol",
  description: "CLI and protocol for agent-to-agent commerce backed by on-chain escrow",
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
