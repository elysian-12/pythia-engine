import { PerformanceClient } from "@/components/performance/PerformanceClient";

export const metadata = {
  title: "Performance · Pythia",
  description:
    "Live audit of the deployed swarm — certification, family rollup, R-distribution, generation evolution.",
};

export default function PerformancePage() {
  return <PerformanceClient />;
}
