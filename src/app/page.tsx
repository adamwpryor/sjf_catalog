export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <div
        className="h-1 w-24 rounded-full"
        style={{ backgroundColor: "var(--sjf-gold)" }}
      />
      <h1
        className="font-serif text-4xl font-semibold sm:text-5xl"
        style={{ color: "var(--sjf-cardinal)" }}
      >
        St. John Fisher University
      </h1>
      <p className="max-w-xl text-lg opacity-80">
        Interactive Academic Catalog
      </p>
      <p className="max-w-md text-sm opacity-60">
        The catalog experience is being provisioned. Programs, courses, and
        requirement pathways will appear here soon.
      </p>
    </main>
  );
}
