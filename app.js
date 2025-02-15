// app.js

// UUID v4 (필요 시 사용)
const uuidv4 = () =>
  ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  );

// ===================== API 및 Supabase 설정 =====================
const TOGETHER_API_KEY = "";
const GROQ_API_KEY = "";

const TOGETHER_API_ENDPOINT = "https://api.together.xyz/v1/chat/completions";
const GROQ_API_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const supabaseUrl = "https://plpkyqiigxrwvzzhngln.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBscGt5cWlpZ3hyd3Z6emhuZ2xuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyMzY1MDUsImV4cCI6MjA1NDgxMjUwNX0.mFb7K_FplAt_zaaROgqRqEGQ6cVPJGtva1W8XzyVGmg";
const supabaseBucket = "my-bucket/groqTogether";

const supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);

// ===================== Helper Functions =====================

/**
 * Supabase 스토리지에 파일을 업로드하고 공개 URL을 반환합니다.
 * (파일명 앞에 타임스탬프를 붙임)
 * @param {File} file - 업로드할 파일
 * @returns {Promise<string>} - 업로드된 이미지의 공개 URL
 */
async function uploadImageToSupabase(file) {
  const fileName = `${Date.now()}_${file.name}`;
  const { error } = await supabaseClient.storage
    .from(supabaseBucket)
    .upload(fileName, file);
  if (error) throw error;
  const { data, error: urlError } = supabaseClient.storage
    .from(supabaseBucket)
    .getPublicUrl(fileName);
  if (urlError) throw urlError;
  return data.publicUrl;
}

/**
 * Gemini API를 호출합니다.
 * @param {Object} payload - API 요청 payload
 * @returns {Promise<Object|null>}
 */
async function callGeminiModels(payload) {
  try {
    const res = await fetch("https://gemini-api-calling.glitch.me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`Gemini API 요청 실패: ${res.status}`);
      return null;
    }
    return res.json();
  } catch (error) {
    console.error(`Gemini API 호출 중 오류 발생: ${error.message}`);
    return null;
  }
}

/**
 * Gemini API 호출 시 재시도 로직 (기본 3회, 지연 3000ms)
 */
async function callGeminiModelsWithGlobalRetry(
  payload,
  retries = 3,
  delay = 3000
) {
  const result = await callGeminiModels(payload);
  if (result) return result;
  if (retries > 0) {
    console.warn(
      `Gemini 응답 없음. ${delay}ms 후 재시도... (남은 재시도: ${retries})`
    );
    await new Promise((res) => setTimeout(res, delay));
    return callGeminiModelsWithGlobalRetry(payload, retries - 1, delay * 2);
  }
  return null;
}

/**
 * 응답 문자열에서 첫 번째 JSON 객체를 추출하여 파싱합니다.
 * @param {string} text - 응답 문자열
 * @returns {Object} - 파싱된 JSON 객체
 */
function robustJSONParse(text) {
  const match = text.match(/{[\s\S]*}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("JSON 추출 실패");
}

/**
 * 문자열 내 첫 번째 '{' ~ 마지막 '}' 사이의 내용을 반환합니다.
 * @param {string} text - 응답 문자열
 * @returns {string}
 */
const extractJSON = (text) => {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first !== -1 && last !== -1 && last > first
    ? text.substring(first, last + 1)
    : text;
};

/**
 * 문자열이 JSON 형태이면 파싱, 아니면 원본 반환
 * @param {string} text - 입력 문자열
 */
const safeJSONParse = (text) => {
  if (text.trim().startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error("JSON 파싱 실패:", e);
    }
  }
  return text;
};

/**
 * 여러 모델 응답 결과에서 각 키별 최빈값(합의)을 도출합니다.
 * @param {Array<Object>} results - 모델 응답 배열
 * @returns {Object} - 합의 결과 객체
 */
function computeConsensus(results) {
  const keys = [
    "species",
    "size",
    "weight",
    "is_predator",
    "is_allowed_in_public",
  ];
  return keys.reduce((acc, key) => {
    const freq = results.reduce((count, res) => {
      if (res[key] !== undefined) count[res[key]] = (count[res[key]] || 0) + 1;
      return count;
    }, {});
    acc[key] = Object.keys(freq).reduce(
      (maxKey, curKey) =>
        freq[curKey] > (freq[maxKey] || 0) ? curKey : maxKey,
      null
    );
    return acc;
  }, {});
}

/**
 * 응답 객체의 HTTP 상태를 확인한 후 JSON을 반환합니다.
 * @param {Response} response - fetch 응답 객체
 * @param {string} label - API 라벨 (에러 메시지용)
 */
async function getJsonOrThrow(response, label) {
  if (!response.ok) {
    const errData = await response.json();
    throw new Error(
      `${label} API HTTP 에러: ${response.status} - ${JSON.stringify(errData)}`
    );
  }
  return response.json();
}

// ===================== DOM 및 이벤트 처리 =====================
document.addEventListener("DOMContentLoaded", () => {
  const imageInput = document.getElementById("imageInput");
  const previewImg = document.getElementById("preview");
  const submitBtn = document.getElementById("submitBtn");
  const resultDiv = document.getElementById("gemini-result");

  // 이미지 선택 시 미리보기 업데이트
  imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file && previewImg) previewImg.src = URL.createObjectURL(file);
  });

  submitBtn.addEventListener("click", async () => {
    if (!imageInput.files?.length) return alert("이미지를 선택해주세요.");
    const file = imageInput.files[0];
    resultDiv.innerText = "이미지 업로드 중입니다...";

    try {
      // 1. 이미지 업로드
      const imageUrl = await uploadImageToSupabase(file);
      console.log("업로드된 이미지 URL:", imageUrl);
      resultDiv.innerText = "이미지 업로드 완료!\n\n모든 모델 호출 중입니다...";

      // 2. Gemini API 호출 준비
      const geminiPayload = {
        messages: [
          {
            role: "user",
            content:
              "다음은 이미지입니다:\n\n![](" +
              imageUrl +
              ")\n\n" +
              "이 이미지를 참고하여 해당 동물의 정보를 아래 JSON 형식에 맞춰서 알려주세요:\n\n" +
              `{
    "species": "동물의 종",
    "size": "대략적인 크기",
    "weight": "대략적인 무게",
    "is_predator": "맹수 여부 (true/false)",
    "is_allowed_in_public": "공공장소 동행 가능 여부 (true/false)"
  }`,
          },
        ],
        maxOutputTokens: 2048,
        temperature: 0.4,
        topP: 1,
        topK: 32,
      };

      // 3. Groq/Together API 호출 준비 (공통 메시지)
      const groqMessages = [
        {
          role: "user",
          content: `
  IMAGE_URL: ${imageUrl}
  supabaseAnonKey: ${supabaseAnonKey}
  key를 써서 url에 접속 가능여부와 이미지의 내용 인식 가능 여부를 알려줘
            `,
        },
      ];
      const requestBodies = {
        together: {
          model: "meta-llama/Llama-Vision-Free",
          messages: groqMessages,
          max_tokens: 512,
          temperature: 0.7,
          top_p: 0.7,
          top_k: 50,
          repetition_penalty: 1,
          stop: ["<|eot|>", "<|eom_id|>"],
          stream: false,
        },
        groq90b: {
          model: "llama-3.2-90b-vision-preview",
          messages: groqMessages,
          max_tokens: 512,
          temperature: 0.7,
          stop: ["<|eot|>", "<|eom_id|>"],
          stream: false,
        },
        groq11b: {
          model: "llama-3.2-11b-vision-preview",
          messages: groqMessages,
          max_tokens: 512,
          temperature: 0.7,
          stop: ["<|eot|>", "<|eom_id|>"],
          stream: false,
        },
      };

      // 4. API 호출 (Gemini와 Groq/Together를 동시에)
      const [geminiResp, togetherResponses] = await Promise.all([
        callGeminiModelsWithGlobalRetry(geminiPayload),
        Promise.all([
          fetch(TOGETHER_API_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TOGETHER_API_KEY}`,
            },
            body: JSON.stringify(requestBodies.together),
          }),
          fetch(GROQ_API_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify(requestBodies.groq90b),
          }),
          fetch(GROQ_API_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify(requestBodies.groq11b),
          }),
        ]),
      ]);

      // 5. 응답 검증 및 JSON 파싱 (Groq/Together)
      const [togetherData, groq90bData, groq11bData] = await Promise.all([
        getJsonOrThrow(togetherResponses[0], "Together"),
        getJsonOrThrow(togetherResponses[1], "GROQ 90b"),
        getJsonOrThrow(togetherResponses[2], "GROQ 11b"),
      ]);

      const parseAPIResponse = (data) =>
        safeJSONParse(
          extractJSON(
            data?.choices?.[0]?.message?.content ||
              JSON.stringify(data, null, 2)
          )
        );

      const togetherResult = parseAPIResponse(togetherData);
      const groq90bResult = parseAPIResponse(groq90bData);
      const groq11bResult = parseAPIResponse(groq11bData);

      // 6. Gemini 응답 파싱
      const geminiResults = [];
      const geminiParsed = [];
      if (geminiResp && Array.isArray(geminiResp)) {
        geminiResp.forEach((res) => {
          try {
            const parsed = robustJSONParse(res.result);
            geminiResults.push({ model: res.modelUsed, result: parsed });
            geminiParsed.push(parsed);
            console.log(`Gemini 모델 ${res.modelUsed} 응답:`, parsed);
          } catch (e) {
            console.warn(
              `Gemini 모델 ${res.modelUsed} 응답 파싱 실패:`,
              res.result
            );
          }
        });
      }

      // 7. 모든 응답 결합 및 최종 합의 도출
      const allResults = [
        ...geminiParsed,
        togetherResult,
        groq90bResult,
        groq11bResult,
      ];
      const aggregatedConsensus = computeConsensus(allResults);

      // 8. 결과 출력
      resultDiv.innerHTML = `
          <h3>각 모델 응답 (파싱된 결과)</h3>
          <pre>${JSON.stringify(
            {
              gemini: geminiResults,
              together: togetherResult,
              groq90b: groq90bResult,
              groq11b: groq11bResult,
            },
            null,
            2
          )}</pre>
          <h3>최종 합의 결과 (Aggregated Consensus)</h3>
          <pre>${JSON.stringify(aggregatedConsensus, null, 2)}</pre>
        `;
    } catch (error) {
      console.error("에러 발생:", error);
      resultDiv.innerText = "에러 발생: " + error.message;
    }
  });
});
