import axios from "axios";

const client = axios.create({
  baseURL: "https://api.semanticscholar.org/graph/v1",
  timeout: 15000,
});

export type Paper = {
  paperId: string;
  title: string;
  year?: number;
  venue?: string;
  authors?: { name: string }[];
  abstract?: string;
  url?: string;
  openAccessPdf?: { url: string; status?: string } | null;
};

export async function searchPapers(params: {
  query: string;
  limit?: number;
  offset?: number;
}) {
  const { query, limit = 10, offset = 0 } = params;

  const fields = [
    "title",
    "year",
    "venue",
    "authors",
    "abstract",
    "url",
    "openAccessPdf",
  ].join(",");

  const res = await client.get("/paper/search", {
    params: { query, limit, offset, fields },
  });

  return res.data as {
    total: number;
    offset: number;
    data: Paper[];
  };
}

export async function getPaper(paperId: string) {
  const fields = [
    "title",
    "year",
    "venue",
    "authors",
    "abstract",
    "url",
    "openAccessPdf",
  ].join(",");

  const res = await client.get(`/paper/${encodeURIComponent(paperId)}`, {
    params: { fields },
  });

  return res.data as Paper;
}
