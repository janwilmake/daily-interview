/// <reference types="@cloudflare/workers-types" />
import twilio from "twilio";

export interface Env {
  OPENAI_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TARGET_PHONE_NUMBER: string;
  WORKER_HOST: string;
  INSTRUCTIONS_URL: string;
  TEST_SECRET: string;
}

export const createStreamPhonecall = async (context: {
  /** Your Twilio Account SID */
  twilioAccountSid: string;
  /** Your Twilio Auth Token */
  twilioAuthToken: string;
  /** Phone number to call in E.164 format (+1234567890) */
  phoneNumber: string;
  /** WebSocket URL for audio streaming */
  streamUrl: string;
  /** Caller ID (Twilio number in E.164 format) */
  fromNumber: string;
}) => {
  const {
    twilioAccountSid,
    twilioAuthToken,
    phoneNumber,
    streamUrl,
    fromNumber,
  } = context;

  try {
    // Validate phone number format
    if (phoneNumber.startsWith("+")) {
      return {
        isSuccessful: false,
        message: "Phone number must be without + (1234567890)",
      };
    }

    // Basic region check
    const isEea = phoneNumber.startsWith("3") || phoneNumber.startsWith("4");
    const isUs = phoneNumber.startsWith("1");
    if (!isEea && !isUs) {
      return {
        isSuccessful: false,
        message: "Only EU and US numbers supported",
      };
    }

    const client = twilio(twilioAccountSid, twilioAuthToken);
    const twiml = new twilio.twiml.VoiceResponse();

    // start or connect???
    // const connect=twiml.connect();
    twiml.connect().stream({
      url: streamUrl,
      name: "LiveAudioStream123",
      // for connect we cannot do "both_tracks". for start, we can.
      // track: "both_tracks",
    });

    const call = await client.calls.create({
      twiml: twiml.toString(),
      to: phoneNumber,
      from: fromNumber,
      record: false,
      machineDetection: "Enable",
    });

    return {
      isSuccessful: true,
      message: "Call initiated with audio stream",
      callSid: call.sid,
    };
  } catch (error: any) {
    console.error("Twilio Error:", error);
    return {
      isSuccessful: false,
      message: error.message || "Failed to initiate call",
    };
  }
};

interface OpenAIEvent {
  type: string;
  delta?: string;
  item_id?: string;
  [key: string]: any;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === "/test" &&
      env.TEST_SECRET === url.searchParams.get("secret")
    ) {
      console.log({ instructionsUrl: env.INSTRUCTIONS_URL });
      const streamUrl = `wss://${env.WORKER_HOST}/media-stream`;
      const result = await createStreamPhonecall({
        twilioAccountSid: env.TWILIO_ACCOUNT_SID,
        twilioAuthToken: env.TWILIO_AUTH_TOKEN,
        phoneNumber: env.TARGET_PHONE_NUMBER,
        streamUrl,
        fromNumber: env.TWILIO_FROM_NUMBER,
      });
      return new Response(JSON.stringify(result, undefined, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    // Handle WebSocket upgrade for media stream
    if (url.pathname === "/media-stream") {
      console.log("RECEIVED /media-stream");
      const instructionsUrl = env.INSTRUCTIONS_URL;
      if (!instructionsUrl) {
        return new Response("No instructions given", { status: 400 });
      }

      const instructionsPromise = fetch(instructionsUrl).then(async (res) => {
        return { status: res.status, text: await res.text() };
      });

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      server.accept();
      handleServerWebSocket(server, env, instructionsPromise);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Trigger the phone call through Twilio
    const result = await createStreamPhonecall({
      twilioAccountSid: env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: env.TWILIO_AUTH_TOKEN,
      phoneNumber: env.TARGET_PHONE_NUMBER,
      streamUrl: `wss://${env.WORKER_HOST}/media-stream`,
      fromNumber: env.TWILIO_FROM_NUMBER,
    });

    if (!result.isSuccessful) {
      throw new Error(`Failed to initiate call: ${result.message}`);
    }

    console.log(`Call initiated successfully: ${result.callSid}`);
  },
};

function handleServerWebSocket(
  twilioWebsocket: WebSocket,
  env: Env,
  instructionsPromise: Promise<{ status: number; text: string }>,
) {
  twilioWebsocket.accept();
  console.log("ENTERED THE WEBSOCKET");
  const audioQueue: any[] = [];
  const VOICE = "ash";
  const LOG_EVENT_TYPES = ["error", "response.content.done"];
  let openAiWs: WebSocket;
  let twilioWebsocketStreamSid: string | null = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: string | null = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;

  async function handleTwilioWebSocket() {
    const BUFFER_SIZE = 20 * 160;
    let inbuffer: Uint8Array = new Uint8Array(0);

    twilioWebsocket.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data.toString());

      if (data.event === "start") {
        const start = data.start;
        twilioWebsocketStreamSid = start.streamSid;
        responseStartTimestampTwilio = null;
        latestMediaTimestamp = 0;

        console.log("got our streamsid", twilioWebsocketStreamSid);
      }

      if (data.event === "media") {
        latestMediaTimestamp = data.media!.timestamp;
        // console.log("media event", latestMediaTimestamp, data.media?.payload);
        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media!.payload,
            }),
          );
        }
      }

      if (data.event === "mark") {
        markQueue.shift();
      }

      if (data.event === "connected") {
        console.log("got connected event from twilio websocket");
        return;
      }

      if (data.event === "stop") {
        return;
      }

      while (inbuffer.length >= BUFFER_SIZE) {
        const chunk = inbuffer.slice(0, BUFFER_SIZE);
        audioQueue.push(chunk);
        inbuffer = inbuffer.slice(BUFFER_SIZE);

        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.send(chunk.buffer);
        } else {
          console.warn("STS WebSocket not open, cannot send chunk");
        }
      }
    });

    twilioWebsocket.addEventListener("error", (ev: any) => {
      console.log("twilioWebsocket error", ev.message);
    });
    twilioWebsocket.addEventListener("close", (ev: any) => {
      openAiWs.close();
      console.log("Twilio connection closed", ev.message);
    });
  }

  async function handleOpenAiWs() {
    const instructionsResult = await instructionsPromise;

    openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      [
        "realtime",
        // Auth
        "openai-insecure-api-key." + env.OPENAI_API_KEY,
        // Beta protocol, required
        "openai-beta.realtime-v1",
      ],
    );
    openAiWs.addEventListener("open", () => {
      console.log("OpenAI WS Open now!");
      const instructions =
        instructionsResult.status === 200
          ? instructionsResult.text
          : "The instructions couldn't be found. Please let the user know that this is the case, and end your conversation afterwards";

      console.log("inst:", instructions.slice(0, 20));

      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("sesh update", sessionUpdate);

      openAiWs.send(JSON.stringify(sessionUpdate));
    });

    openAiWs.addEventListener("message", async (event) => {
      try {
        const response: OpenAIEvent = JSON.parse(event.data);
        console.log("event", response.type);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log("OpenAI Event:", response.type, response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: twilioWebsocketStreamSid,
            media: { payload: response.delta },
          };
          twilioWebsocket.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (response.item_id) lastAssistantItem = response.item_id;

          if (twilioWebsocketStreamSid) {
            // send mark event
            const markEvent = {
              event: "mark",
              streamSid: twilioWebsocketStreamSid,
              mark: { name: "responsePart" },
            };
            twilioWebsocket.send(JSON.stringify(markEvent));
            markQueue.push("responsePart");
          }
        }

        if (response.type === "input_audio_buffer.speech_started") {
          if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
            const elapsedTime =
              latestMediaTimestamp - responseStartTimestampTwilio;
            if (lastAssistantItem) {
              openAiWs.send(
                JSON.stringify({
                  type: "conversation.item.truncate",
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms: elapsedTime,
                }),
              );
            }
            twilioWebsocket.send(
              JSON.stringify({
                event: "clear",
                streamSid: twilioWebsocketStreamSid,
              }),
            );
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
          }
        }
      } catch (error) {
        console.error("OpenAI message error:", error);
      }
    });
    //
    openAiWs.addEventListener("error", (ev: any) => {
      console.log("openaiWs error", ev.message);
    });
    openAiWs.addEventListener("close", (ev: any) => {
      twilioWebsocket.close();
      console.log("OpenAI connection closed", JSON.stringify(ev));
    });
  }

  handleOpenAiWs();
  handleTwilioWebSocket();
}
