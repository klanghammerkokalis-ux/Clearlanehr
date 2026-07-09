// netlify/functions/generate-policy.js
//
// Flow:
// 1. Receives { session_id, companyName, state, companySize, leaveTypes } from generator.html
// 2. Verifies with Stripe that session_id represents a completed ($47) payment
// 3. If paid, calls the Anthropic API to generate a compliance-ready LOA policy document
// 4. Returns { document: "..." } as plain text for the frontend to render/download
//
// Required Netlify environment variables (Site configuration -> Environment variables):
//   STRIPE_SECRET_KEY   -> your Stripe secret key (sk_live_... or sk_test_...)
//   ANTHROPIC_API_KEY   -> your Anthropic API key

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { session_id, companyName, state, companySize, leaveTypes } = payload;

  if (!session_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing session_id. This tool must be accessed after completing checkout." }) };
  }
  if (!companyName || !state || !companySize) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required company information." }) };
  }

  // ---- Step 1: Verify payment with Stripe ----
  let session;
  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        },
      }
    );
    if (!stripeRes.ok) {
      const errText = await stripeRes.text();
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({ error: "Could not verify payment with Stripe.", detail: errText }),
      };
    }
    session = await stripeRes.json();
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Error contacting Stripe.", detail: String(e) }) };
  }

  if (session.payment_status !== "paid") {
    return {
      statusCode: 402,
      headers,
      body: JSON.stringify({ error: "Payment not confirmed. If you just paid, wait a few seconds and refresh." }),
    };
  }

  // ---- Step 2: Generate the document via Claude ----
  const leaveTypesList = Array.isArray(leaveTypes) && leaveTypes.length
    ? leaveTypes.join(", ")
    : "FMLA, ADA, and applicable state paid leave";

  const prompt = `You are an expert HR compliance consultant drafting a leave-of-absence (LOA) policy document for a small-to-midsize employer. Write a complete, ready-to-use, professionally formatted LOA policy.

Company details:
- Company name: ${companyName}
- Primary state of operation: ${state}
- Approximate company size: ${companySize} employees
- Leave types to cover: ${leaveTypesList}

Requirements:
- Cite the correct federal laws where applicable: FMLA (29 CFR Part 825) if the company likely meets the 50-employee threshold, ADA, USERRA, and the PUMP Act, and note eligibility thresholds clearly rather than assuming they're met.
- Include the specific state-level paid leave, sick leave, or family leave law(s) that apply in ${state}, described accurately and without inventing specifics you are not confident about — flag anything the company should confirm with counsel.
- Structure the document with clear headers: Purpose & Scope, Eligibility, Types of Leave Covered (one subsection per leave type requested), Notice & Documentation Requirements, Job Protection & Benefits Continuation, Intermittent Leave, Return to Work, Employer Responsibilities, and a short Manager Quick-Reference summary in plain language at the end.
- Write in clear, plain business English a non-lawyer manager could follow, while remaining legally accurate.
- Do not include placeholder brackets like [INSERT X] — write complete, usable content throughout.
- At the very top, include a short italicized disclaimer that this document was generated as a starting point and should be reviewed by qualified legal counsel before adoption, since employment law varies by jurisdiction and changes over time.

Output only the policy document itself, formatted in clean Markdown with headers.`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Document generation failed.", detail: errText }),
      };
    }

    const data = await anthropicRes.json();
    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!textBlocks) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "No document content returned." }) };
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ document: textBlocks }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Error generating document.", detail: String(e) }) };
  }
};
