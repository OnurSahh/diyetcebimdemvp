import { getConfiguredAiProviderMode } from "@/lib/ai/config";

function extractGroqChatContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = record.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : "";
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

export async function generateVisionTextWithConfiguredProvider(params: {
  prompt: string;
  mimeType: string;
  base64Data: string;
}): Promise<string> {
  const { prompt, mimeType, base64Data } = params;

  if (getConfiguredAiProviderMode() === 1) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY is missing");
    }

    const model =
      process.env.GROQ_VISION_MODEL?.trim() || "meta-llama/llama-4-scout-17b-16e-instruct";

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${base64Data}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Groq vision request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const text = extractGroqChatContent(payload);
    if (!text) {
      throw new Error("Groq vision returned empty text");
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
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: base64Data,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 1600,
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
        throw new Error(`Gemini vision request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      const text = extractGeminiOutputText(payload);
      if (!text) {
        errors.push(`${model}:empty`);
        continue;
      }

      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Gemini vision error";
      errors.push(`${model}:${message}`);
    }
  }

  throw new Error(`Gemini vision request failed for all configured models (${errors.join(", ")})`);
}
