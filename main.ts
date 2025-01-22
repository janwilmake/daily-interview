/// <reference types="@cloudflare/workers-types" />

import { createStreamPhonecall } from "./createStreamPhonecall";

export interface Env {
  OPENAI_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TARGET_PHONE_NUMBER: string;
  WORKER_HOST: string;
}

interface TwilioMediaMessage {
  event: string;
  media?: {
    payload: string;
    timestamp: number;
  };
  start?: {
    streamSid: string;
  };
  mark?: {
    name: string;
  };
}

interface OpenAIEvent {
  type: string;
  delta?: string;
  item_id?: string;
  [key: string]: any;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle incoming call webhook
    if (url.pathname === "/incoming-call") {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                    <Pause length="1"/>
                    <Say>O.K. you can start talking!</Say>
                    <Connect>
                        <Stream url="wss://${url.host}/media-stream" />
                    </Connect>
                </Response>`;

      return new Response(twiml, {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Handle WebSocket upgrade for media stream
    if (url.pathname === "/media-stream") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      handleServerWebSocket(server, env);

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

function handleServerWebSocket(server: WebSocket, env: Env) {
  const SYSTEM_MESSAGE = "You are a helpful and bubbly AI assistant..."; // Keep your original message
  const VOICE = "alloy";
  const LOG_EVENT_TYPES = ["error", "response.content.done"];
  const SHOW_TIMING_MATH = false;

  let streamSid: string | null = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem: string | null = null;
  let markQueue: string[] = [];
  let responseStartTimestampTwilio: number | null = null;

  // Create OpenAI WebSocket connection
  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    },
  );

  // OpenAI WebSocket handlers
  openAiWs.addEventListener("open", () => {
    console.log("Connected to OpenAI");
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    };
    openAiWs.send(JSON.stringify(sessionUpdate));
  });

  openAiWs.addEventListener("message", (event) => {
    try {
      const response: OpenAIEvent = JSON.parse(event.data);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log("OpenAI Event:", response.type, response);
      }

      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid: streamSid,
          media: { payload: response.delta },
        };
        server.send(JSON.stringify(audioDelta));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        if (response.item_id) lastAssistantItem = response.item_id;

        sendMark(server, streamSid);
      }

      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStarted();
      }
    } catch (error) {
      console.error("OpenAI message error:", error);
    }
  });

  // Twilio WebSocket handlers
  server.addEventListener("message", (event) => {
    try {
      const data: TwilioMediaMessage = JSON.parse(event.data.toString());

      switch (data.event) {
        case "media":
          latestMediaTimestamp = data.media!.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media!.payload,
              }),
            );
          }
          break;
        case "start":
          streamSid = data.start!.streamSid;
          console.log("Stream started:", streamSid);
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;
        case "mark":
          markQueue.shift();
          break;
      }
    } catch (error) {
      console.error("Twilio message error:", error);
    }
  });

  // Helper functions
  function handleSpeechStarted() {
    if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
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
      server.send(
        JSON.stringify({
          event: "clear",
          streamSid: streamSid,
        }),
      );
      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  }

  function sendMark(connection: WebSocket, streamSid: string | null) {
    if (streamSid) {
      const markEvent = {
        event: "mark",
        streamSid: streamSid,
        mark: { name: "responsePart" },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    }
  }

  // Cleanup handlers
  server.addEventListener("close", () => {
    openAiWs.close();
    console.log("Twilio connection closed");
  });

  openAiWs.addEventListener("close", () => {
    server.close();
    console.log("OpenAI connection closed");
  });
}
