# Daily Interview

Holding Interviews is a good interface of conveying information as it is in natural language. The problem is most people don't have the amount of fame to be interviewed. But that's no longer a problem with AI realtime phonecalls.

The goal of this repo is to establish a service where a GitHub user can sign up and get a daily phonecall from an AI agent where:

POC:

- ✅ get the realtime speech-to-speech to work, including with a daily cronjob, with demo instructions.
- ✅ outgoing phonecall to user phone number (use screenless number so it's already recorded)
- get my repos active in last 24 hours
- then get readme for those (file.forgithub.com/janwilmake/README.md?repos=x,y,z)
- craft prompt based on these repos, to interview the developer about it.

MVP:

- User can authenticate with github to register to the service, which sets up a daily cronjob at a configurable time. Cost: $30 per month. Direct
- https://join.forgithub.com/owner/*/commits?date=xxxx-xx-xx&from&until -> all commits of all repos for a given date or timerange
- the AI agent knows what the user has done today (looking at repos active today, looking at commits in the last 24 hours)

# How to use

- Clone the repo
- Copy `.dev.vars.example` into `.dev.vars` and fill all the variables. Be sure to have bought a Twilio phone number that you connect here. The cloudflare API token needs to be able to manage cloudflare workers.
- To test things locally, use ngrok: `brew install ngrok` -> `ngrok http 3000` and use that as `WORKER_HOST` in `.dev.vars` and after running with `npx wrangler dev --port 3000`, go to http://localhost:3000/test and receive your call.
