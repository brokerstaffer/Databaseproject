export default function ExportPage() {
  return (
    <div className="flex h-full flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Export</h1>
      <div className="flex flex-1 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm text-neutral-400 shadow-sm">
        Your exported lists (CSV downloads and Send-to-Clay pushes) will appear here.
      </div>
    </div>
  );
}
