import twilio from "twilio";

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
    if (!phoneNumber.startsWith("+")) {
      return {
        isSuccessful: false,
        message: "Phone number must be in E.164 format (+1234567890)",
      };
    }

    // Basic region check
    const isEea = phoneNumber.startsWith("+3") || phoneNumber.startsWith("+4");
    const isUs = phoneNumber.startsWith("+1");
    if (!isEea && !isUs) {
      return {
        isSuccessful: false,
        message: "Only EU and US numbers supported",
      };
    }

    const client = twilio(twilioAccountSid, twilioAuthToken);
    const twiml = new twilio.twiml.VoiceResponse();

    const connect = twiml.connect();
    connect.stream({
      url: streamUrl,
      name: "LiveAudioStream",
      track: "both_tracks",
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
      price: call.price,
    };
  } catch (error: any) {
    console.error("Twilio Error:", error);
    return {
      isSuccessful: false,
      message: error.message || "Failed to initiate call",
    };
  }
};
