export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': 'https://limenbridge.cc',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const body = await request.json();
    const resp = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.MAILERLITE_API_KEY
      },
      body: JSON.stringify(body)
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': 'https://limenbridge.cc',
        'Content-Type': 'application/json'
      }
    });
  }
};
