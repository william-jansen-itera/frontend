import { NextResponse } from 'next/server';
import { logException, logTrace } from '@/server/utils/logging';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';
import { buildUserAgentSummary } from '@/server/utils/userAgent';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isValidEmail(value) {
  const normalizedValue = normalizeText(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedValue);
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeContactProfile(value) {
  const normalizedValue = normalizeText(value).toLowerCase();

  if (normalizedValue === 'individual' || normalizedValue === 'company') {
    return normalizedValue;
  }

  return '';
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const contactProfile = normalizeContactProfile(payload?.contactProfile);
    const name = normalizeText(payload?.name);
    const company = normalizeText(payload?.company);
    const email = normalizeText(payload?.email);
    const phone = normalizeText(payload?.phone);
    const message = normalizeText(payload?.message);
    const wantsCall = normalizeBoolean(payload?.wantsCall);
    const rawUserAgent = request.headers.get('user-agent') ?? null;
    const userAgentSummary = buildUserAgentSummary(rawUserAgent);

    if (!contactProfile) {
      return NextResponse.json({ error: 'Please select whether this is for an individual or a company.' }, { status: 400 });
    }

    if (!name) {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
    }

    if (contactProfile === 'company' && !company) {
      return NextResponse.json({ error: 'Company name is required when submitting as a company.' }, { status: 400 });
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }

    if (!message) {
      return NextResponse.json({ error: 'A message is required.' }, { status: 400 });
    }

    if (wantsCall && !phone) {
      return NextResponse.json({ error: 'A phone number is required if you want a call.' }, { status: 400 });
    }

    await withSqlConnection(async () => {
      await new sql.Request()
        .input('app_identifier', sql.NVarChar(128), getRequiredApplicationIdentifier())
        .input('contact_profile', sql.NVarChar(20), contactProfile)
        .input('name', sql.NVarChar(200), name)
        .input('company', sql.NVarChar(200), company || null)
        .input('email', sql.NVarChar(320), email)
        .input('phone', sql.NVarChar(64), phone || null)
        .input('wants_call', sql.Bit, wantsCall)
        .input('message', sql.NVarChar(sql.MAX), message)
        .input('user_agent', sql.NVarChar(1000), userAgentSummary)
        .query(`
          INSERT INTO dbo.contact_requests (
            app_identifier,
            contact_profile,
            name,
            company,
            email,
            phone,
            wants_call,
            message,
            user_agent
          )
          VALUES (
            @app_identifier,
            @contact_profile,
            @name,
            @company,
            @email,
            @phone,
            @wants_call,
            @message,
            @user_agent
          );
        `);
    });

    await logTrace(JSON.stringify({
      event: 'contact_request_submitted',
      contactProfile,
      name,
      company: company || null,
      email,
      phone: phone || null,
      wantsCall,
      message,
      userAgent: userAgentSummary,
      userAgentRaw: rawUserAgent,
      submittedAt: new Date().toISOString(),
    }));

    return NextResponse.json({
      message: wantsCall
        ? 'Thanks. Your request was sent, and we will reach out about a call.'
        : 'Thanks. Your message was sent, and we will get back to you by email.',
    });
  } catch (error) {
    await logException(error);

    return NextResponse.json(
      { error: 'Your message could not be sent right now.' },
      { status: 500 },
    );
  }
}