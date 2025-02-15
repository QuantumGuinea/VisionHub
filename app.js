// app.js

// -------------------- 설정 상수 --------------------
// 서버 프록시 엔드포인트 (Glitch 환경변수에 설정된 API 키 사용)
const BASE_API_URL = "https://api-calling.glitch.me";
const GEMINI_API_ENDPOINT = BASE_API_URL + "/api/gemini";
const TOGETHER_API_ENDPOINT = BASE_API_URL + "/api/together";
const GROQ_API_ENDPOINT = BASE_API_URL + "/api/groq";

// Supabase 설정
const supabaseUrl = "https://pwuuasxrbjfxndcqyaql.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3dXVhc3hyYmpmeG5kY3F5YXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0NDYzMjQsImV4cCI6MjA1NTAyMjMyNH0.0XMx7rweHHAbSVbCxLKCU5cm4f5zm2u0sh5i54cbGEg";
const SUPABASE_BUCKET = "my-bucket";

const supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);

// -------------------- 헬퍼 함수 --------------------

// Supabase에 파일 업로드 (폴더 선택 가능)
async function uploadImageToSupabase(file, folder = "") {
  const fileName = folder
    ? `${folder}/${Date.now()}_${file.name}`
    : `${Date.now()}_${file.name}`;
  const { error } = await supabaseClient.storage
    .from(SUPABASE_BUCKET)
    .upload(fileName, file);
  if (error) throw error;
  const { data, error: urlError } = supabaseClient.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(fileName);
  if (urlError) throw urlError;
  return data.publicUrl;
}

// 메시지 템플릿 생성 (토큰 최적화를 위해 JSON 내부 공백 제거)
function createMessagePayload(imageUrl) {
  return [
    {
      role: "user",
      content: `다음은 이미지입니다:\n\n![](${imageUrl})\n\n이 이미지를 참고하여 해당 동물의 정보를 아래 JSON 형식에 맞춰 알려주세요:\n\n{"species":"동물의 종","size":"대략적인 크기","weight":"대략적인 무게","is_predator":"맹수 여부 (true/false)","is_allowed_in_public":"공공장소 동행 가능 여부 (true/false)"}`,
    },
  ];
}

// Gemini API 호출 및 재시도 로직
async function callGeminiModels(payload) {
  const res = await fetch(GEMINI_API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Gemini API HTTP 에러: " + res.status);
  return res.json();
}

async function callGeminiWithRetry(payload, retries = 3, delay = 3000) {
  try {
    const result = await callGeminiModels(payload);
    if (result) return result;
  } catch (e) {
    console.warn(`Gemini 호출 오류: ${e.message}`);
  }
  if (retries > 0) {
    console.warn(`재시도 중... 남은 재시도: ${retries}`);
    await new Promise((res) => setTimeout(res, delay));
    return callGeminiWithRetry(payload, retries - 1, delay * 2);
  }
  throw new Error("Gemini API 요청 실패");
}

// 공통 API 호출 함수 (Together, GROQ)
// 클라이언트에서는 별도의 API 키 없이 서버 프록시를 호출합니다.
async function callApi(endpoint, body, label) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(
        `${label} API HTTP 에러: ${response.status} - ${JSON.stringify(
          errData
        )}`
      );
    }
    return await response.json();
  } catch (error) {
    console.error(`${label} API 호출 중 오류:`, error.message);
    throw error;
  }
}

// 응답 내 JSON 객체 추출 및 파싱
function extractJSON(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first !== -1 && last !== -1 && last > first
    ? text.substring(first, last + 1)
    : text;
}
function safeJSONParse(text) {
  if (text.trim().startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error("JSON 파싱 실패:", e);
    }
  }
  return text;
}
function parseAPIResponse(data) {
  const content =
    data?.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
  try {
    return safeJSONParse(extractJSON(content));
  } catch (e) {
    console.error("응답 파싱 오류:", e);
    return null;
  }
}

// 여러 응답 결과에서 각 키의 최빈값(합의) 도출
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
      if (res && res[key] !== undefined)
        count[res[key]] = (count[res[key]] || 0) + 1;
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

// -------------------- DOM 및 이벤트 처리 --------------------
document.addEventListener("DOMContentLoaded", () => {
  const imageInput = document.getElementById("imageInput");
  const previewImg = document.getElementById("preview");
  const submitBtn = document.getElementById("submitBtn");
  const resultDiv = document.getElementById("gemini-result");

  // 이미지 선택 시 미리보기 업데이트
  imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) previewImg.src = URL.createObjectURL(file);
  });

  submitBtn.addEventListener("click", async () => {
    if (!imageInput.files?.length) {
      alert("이미지를 선택해주세요.");
      return;
    }
    const file = imageInput.files[0];
    resultDiv.innerText = "이미지 업로드 중입니다...";

    try {
      // 1. 이미지 업로드 (폴더: uploads)
      const imageUrl = await uploadImageToSupabase(file, "uploads");
      console.log("업로드된 이미지 URL:", imageUrl);
      resultDiv.innerText = "이미지 업로드 완료!\nAPI 호출 중입니다...";

      // 2. 메시지 구성 (토큰 최소화 버전)
      const messages = createMessagePayload(imageUrl);

      // 3. 각 API 요청 페이로드 (모델별 파라미터 조정)
      const geminiPayload = {
        messages,
        max_tokens: 128,
        temperature: 0.3,
        top_p: 1,
        top_k: 32,
      };
      const togetherPayload = {
        model: "meta-llama/Llama-Vision-Free",
        messages,
        max_tokens: 128,
        temperature: 0.3,
        top_p: 1,
        top_k: 32,
        repetition_penalty: 1,
        stop: ["<|eot|>", "<|eom_id|>"],
        stream: false,
      };
      const groqPayload = {
        model: "llama-3.2-90b-vision-preview",
        messages,
        max_tokens: 128,
        temperature: 0.3,
        stop: ["<|eot|>", "<|eom_id|>"],
        stream: false,
      };

      // 4. API 동시 호출 (Gemini 재시도 포함)
      const [geminiRes, togetherRes, groqRes] = await Promise.all([
        callGeminiWithRetry(geminiPayload),
        callApi(TOGETHER_API_ENDPOINT, togetherPayload, "Together"),
        callApi(GROQ_API_ENDPOINT, groqPayload, "GROQ"),
      ]);

      // 5. 응답 파싱
      const geminiData = Array.isArray(geminiRes)
        ? geminiRes.map((r) => {
            try {
              return safeJSONParse(extractJSON(r.result));
            } catch (e) {
              console.warn("Gemini 파싱 실패:", r.result);
              return null;
            }
          })
        : [];
      const togetherData = parseAPIResponse(togetherRes);
      const groqData = parseAPIResponse(groqRes);

      const allResults = [
        ...geminiData.filter(Boolean),
        togetherData,
        groqData,
      ].filter(Boolean);
      const consensus = computeConsensus(allResults);

      // 6. 결과 출력
      resultDiv.innerHTML = `
        <h3>각 API 응답</h3>
        <pre>${JSON.stringify(
          { gemini: geminiData, together: togetherData, groq: groqData },
          null,
          2
        )}</pre>
        <h3>최종 합의 결과</h3>
        <pre>${JSON.stringify(consensus, null, 2)}</pre>
      `;
    } catch (error) {
      console.error("에러 발생:", error);
      resultDiv.innerText = "에러 발생: " + error.message;
    }
  });
});

// --- Helper: Supabase 이미지 업로드 ---
async function uploadImageToSupabase(file) {
  const fileName = `${Date.now()}_${file.name}`;
  const { error } = await supabaseClient.storage
    .from(SUPABASE_BUCKET)
    .upload(fileName, file);
  if (error) throw error;
  const { data, error: urlError } = supabaseClient.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(fileName);
  if (urlError) throw urlError;
  return data.publicUrl;
}

// --- Gemini API 호출 (서버 프록시) ---
async function callGeminiModels(payload) {
  try {
    const res = await fetch(GEMINI_API_ENDPOINT, {
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
