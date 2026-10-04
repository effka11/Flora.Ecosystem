import { redirect } from "next/navigation";
import { loginPathWithBuildBust } from "@/lib/buildId";

export default function Home() {
  redirect(loginPathWithBuildBust());
}
