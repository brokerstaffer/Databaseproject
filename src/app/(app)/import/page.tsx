export default function ImportPage() {
  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Import</h1>
      <div className="flex flex-1 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm text-neutral-400 shadow-sm">
        Data imported from Courted / Zillow / Realtor.com (via the scraper webhook) will appear here.
      </div>
    </div>
  );
}
