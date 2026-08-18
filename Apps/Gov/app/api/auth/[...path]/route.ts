import type { NextRequest } from "next/server";
import { floraApiProxyOptions, proxyFloraApiRequest } from "@/lib/floraApiProxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function HEAD(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function PUT(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return proxyFloraApiRequest(request);
}

export async function OPTIONS(request: NextRequest): Promise<Response> {
  return floraApiProxyOptions(request);
}
