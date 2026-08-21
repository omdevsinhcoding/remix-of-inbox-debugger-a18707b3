import { useEffect } from "react";
import { Link } from "react-router-dom";

const CANONICAL_PATH = "/guides/netflix-household-verification";

const setMeta = (selector: string, attr: string, value: string) => {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    const [k, v] = selector.replace(/[\[\]"]/g, "").split("=");
    el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
};

const NetflixHouseholdVerificationGuide = () => {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Netflix Household Verification: Travel Codes & OTP Guide";

    setMeta('meta[name="description"]', "content", "Complete guide to Netflix household verification: how to approve travel prompts, request temporary access codes, and fix 'device not part of household' errors while traveling.");
    setMeta('meta[property="og:title"]', "content", "Netflix Household Verification Guide");
    setMeta('meta[property="og:description"]', "content", "Step-by-step help for Netflix household verification prompts, OTP travel codes, and temporary access.");
    setMeta('meta[property="og:type"]', "content", "article");

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = CANONICAL_PATH;

    const ldId = "ld-netflix-household-guide";
    let ld = document.getElementById(ldId) as HTMLScriptElement | null;
    if (!ld) {
      ld = document.createElement("script");
      ld.type = "application/ld+json";
      ld.id = ldId;
      document.head.appendChild(ld);
    }
    ld.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is Netflix household verification?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Netflix household verification is a check that confirms a device streaming Netflix belongs to the same physical location as the primary account holder. If a device is used outside the household, Netflix may block playback until it is verified by an emailed OTP or a temporary travel code.",
          },
        },
        {
          "@type": "Question",
          name: "How do I get a Netflix travel code while traveling?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "On the blocked device, choose 'Verify Device' or 'Get help'. Netflix sends a 4-digit OTP to the account holder's email or phone. Enter the code within 15 minutes to grant that device temporary access, typically valid for up to 7 days before another verification is required.",
          },
        },
        {
          "@type": "Question",
          name: "Why does Netflix keep asking me to verify my household?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Repeated prompts usually mean the device's IP address does not match the primary Wi-Fi network Netflix has associated with your household. Connect the device to your home Wi-Fi and open Netflix at least once every 31 days, or add the user as an Extra Member.",
          },
        },
        {
          "@type": "Question",
          name: "How long does a Netflix travel verification last?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "A verified device typically stays approved for about 7 days on the new network. After that period Netflix will re-check the device and may request a new OTP if it is still away from the primary household.",
          },
        },
      ],
    });

    return () => {
      document.title = prevTitle;
    };
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <nav className="mb-8 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground">Home</Link>
          <span className="mx-2">/</span>
          <span>Guides</span>
          <span className="mx-2">/</span>
          <span className="text-foreground">Netflix Household Verification</span>
        </nav>

        <article className="prose prose-invert max-w-none">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Netflix Household Verification: Travel Codes, OTP & Temporary Access Explained
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Getting hit with a "This device isn't part of your Netflix Household" prompt while traveling
            or logging in from a friend's Wi-Fi? This guide walks you through exactly what the check
            does, how to request a Netflix travel code, and how to stop it from popping up again.
          </p>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">What is a Netflix Household?</h2>
            <p>
              A Netflix Household is the collection of devices linked to the same Wi-Fi network at the
              home address on the account. Netflix uses your IP address, device IDs, and account
              activity to decide which devices belong to that household. Anyone outside it either needs
              a temporary verification code or an Extra Member slot on the account.
            </p>
          </section>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">When you will see the verification prompt</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>Signing in on a hotel, Airbnb, or public Wi-Fi network.</li>
              <li>Streaming from a laptop, phone, or smart TV that hasn't touched the home Wi-Fi in over 31 days.</li>
              <li>Using a VPN that changes your IP location.</li>
              <li>Switching ISPs, resetting your router, or moving house.</li>
            </ul>
          </section>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">How to get a Netflix travel code (step by step)</h2>
            <ol className="list-decimal pl-6 space-y-3">
              <li>On the blocked device, tap <strong>Verify Device</strong> on the "Whose TV is this?" screen.</li>
              <li>Choose whether Netflix should send the OTP to the account holder's <strong>email</strong> or <strong>phone number</strong>.</li>
              <li>Open the inbox (or SMS) of the primary account holder — the message subject usually starts with "Your Netflix temporary access code".</li>
              <li>Copy the 4-digit code and enter it on the blocked device within <strong>15 minutes</strong>.</li>
              <li>Playback resumes. The device is now approved for roughly <strong>7 days</strong> on that network.</li>
            </ol>
            <p className="text-sm text-muted-foreground">
              Tip: if the account holder isn't nearby, forward the verification email to yourself or use
              a shared inbox tool so you can grab the code without waking anyone up.
            </p>
          </section>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">Stop household prompts from coming back</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Update your Netflix Household:</strong> open Netflix on the TV connected to your home Wi-Fi and go to <em>Account → Manage Netflix Household → Update Netflix Household</em>.</li>
              <li><strong>Reconnect every month:</strong> take traveling devices home and open Netflix at least once every 31 days to refresh the household link.</li>
              <li><strong>Add an Extra Member:</strong> if someone lives at a different address permanently, add them as an Extra Member from the Account page — no more travel codes needed.</li>
              <li><strong>Turn off VPNs</strong> before the verification screen loads, since they force Netflix to see a foreign IP.</li>
            </ul>
          </section>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">Troubleshooting the OTP</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Code never arrives:</strong> check spam, verify the email on file at netflix.com/account, and request a new code after 60 seconds.</li>
              <li><strong>"Code expired":</strong> codes are valid for 15 minutes — request a fresh one directly from the TV screen.</li>
              <li><strong>Stuck in a loop:</strong> sign out fully, restart the device, then sign back in on the same Wi-Fi you plan to keep using.</li>
              <li><strong>Still blocked:</strong> contact Netflix support in-app — they can grant a one-off manual override for legitimate travel.</li>
            </ul>
          </section>

          <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-semibold">FAQ</h2>
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">Does Netflix charge for travel codes?</h3>
                <p>No — temporary access codes are free. Extra Member slots are the paid option for permanent second-home use.</p>
              </div>
              <div>
                <h3 className="font-semibold">How many travel codes can I request?</h3>
                <p>Netflix does not publish a hard cap, but requesting many codes back-to-back can trigger a manual review. Space requests out and reconnect to your home Wi-Fi when you can.</p>
              </div>
              <div>
                <h3 className="font-semibold">Will a VPN bypass household verification?</h3>
                <p>Sometimes, if the VPN exits from your home city — but Netflix actively blocks known VPN IP ranges, so it is unreliable. A proper travel code is the safer path.</p>
              </div>
            </div>
          </section>

          <div className="mt-12 rounded-2xl border border-border/60 bg-card/60 p-5 text-sm text-muted-foreground">
            Need to receive Netflix OTPs on a shared mailbox? Head back to the{" "}
            <Link to="/" className="underline underline-offset-2 text-foreground">profile picker</Link>{" "}
            and open your inbox — verification codes are auto-highlighted for you.
          </div>
        </article>
      </div>
    </main>
  );
};

export default NetflixHouseholdVerificationGuide;
