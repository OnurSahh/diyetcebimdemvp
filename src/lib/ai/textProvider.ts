import { getConfiguredAiProviderMode } from "@/lib/ai/config";

export function getAiProviderMode(): 0 | 1 {
  return getConfiguredAiProviderMode();
}

function extractGroqOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (typeof record.output_text === "string" && record.output_text.trim().length > 0) {
    return record.output_text;
  }

  const chatText = record.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.trim().length > 0) {
    return chatText;
  }

  const first = record.output?.[0]?.content?.[0]?.text;
  return typeof first === "string" ? first : "";
}

function extractGroqErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "Groq request failed";
  }

  const message = (payload as { error?: { message?: string } }).error?.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "Groq request failed";
}

function extractGeminiOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = record.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" ? text : "";
}

export async function generateTextWithConfiguredProvider(prompt: string): Promise<string> {
  if (getAiProviderMode() === 1) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is missing");
    }

    const model = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b";
    const baseBody = {
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "Return valid JSON only. No markdown or code fences.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    const firstResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...baseBody,
        response_format: { type: "json_object" },
      }),
    });

    let payload = (await firstResponse.json()) as unknown;

    if (!firstResponse.ok) {
      const errorCode = (payload as { error?: { code?: string } }).error?.code;
      if (firstResponse.status === 400 && errorCode === "json_validate_failed") {
        const retryResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(baseBody),
        });

        payload = (await retryResponse.json()) as unknown;
        if (!retryResponse.ok) {
          throw new Error(extractGroqErrorMessage(payload));
        }
      } else {
        throw new Error(extractGroqErrorMessage(payload));
      }
    }

    const text = extractGroqOutputText(payload);
    if (!text) {
      throw new Error("Groq returned empty text");
    }

    return text;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const modelCandidates = Array.from(
    new Set(
      [
        process.env.GEMINI_MODEL,
        "gemini-3-flash-preview",
        "gemini-flash-latest",
        "gemini-1.5-flash-latest",
        "gemini-2.0-flash",
      ]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const errors: string[] = [];

  for (const model of modelCandidates) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 2200,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );

      if (!response.ok) {
        errors.push(`${model}:${response.status}`);
        if (response.status === 404 || response.status === 503) {
          continue;
        }
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      const text = extractGeminiOutputText(payload);
      if (!text) {
        errors.push(`${model}:empty`);
        continue;
      }

      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Gemini error";
      errors.push(`${model}:${message}`);
    }
  }

  throw new Error(`Gemini request failed for all configured models (${errors.join(", ")})`);
}
