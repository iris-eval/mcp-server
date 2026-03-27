import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export default function LearnLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <Nav />
      {children}
      <Footer />
    </>
  );
}
