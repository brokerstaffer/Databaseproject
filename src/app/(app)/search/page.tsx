import { AgentSearch } from "@/components/agents/agent-search";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <AgentSearch initialQuery={q ?? ""} />;
}
