import express from "express";
import "dotenv/config";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import axios from "axios";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { GoogleGenAI, Type } from "@google/genai";
import db from "./src/db"; // Note: using .js for ESM compatibility in some environments, but tsx handles it
import { Resend } from "resend";
import { v4 as uuidv4 } from "uuid";

const JWT_SECRET = process.env.JWT_SECRET || "kagenoname-secret-key";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cookieParser());

  const upload = multer({ storage: multer.memoryStorage() });

  // --- Auth Middleware ---
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  const isAdmin = (req: any, res: any, next: any) => {
    if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: "Forbidden" });
    next();
  };

  // --- API Routes ---

  // Auth Routes
  app.post("/api/auth/demo", (req, res) => {
    const user = {
      id: "demo-user-id",
      googleId: "demo-google-id",
      email: process.env.ADMIN_EMAIL || "demo@example.com",
      name: "Demo User",
      avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Demo",
      role: 'ADMIN' // Give admin role to demo user for testing
    };

    // Ensure user exists in DB
    const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    if (!existing) {
      db.prepare("INSERT INTO users (id, googleId, email, name, avatar, role) VALUES (?, ?, ?, ?, ?, ?)").run(
        user.id, user.googleId, user.email, user.name, user.avatar, user.role
      );
    }

    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ success: true });
  });

  app.get("/api/auth/url", (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: "Google OAuth not configured" });
    }
    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = {
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      access_type: "offline",
      response_type: "code",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
      ].join(" "),
    };
    const qs = new URLSearchParams(options);
    res.json({ url: `${rootUrl}?${qs.toString()}` });
  });

  app.get("/auth/callback", async (req, res) => {
    const code = req.query.code as string;
    try {
      // Exchange code for tokens
      const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.APP_URL}/auth/callback`,
        grant_type: "authorization_code",
      });

      const { access_token } = tokenResponse.data;
      const userResponse = await axios.get(`https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${access_token}`);
      const googleUser = userResponse.data;

      // Check user in DB
      let user = db.prepare("SELECT * FROM users WHERE googleId = ?").get(googleUser.id) as any;
      let isNewUser = false;

      if (!user) {
        isNewUser = true;
        user = {
          id: uuidv4(),
          googleId: googleUser.id,
          email: googleUser.email,
          name: googleUser.name,
          avatar: googleUser.picture,
          role: 'USER'
        };
        db.prepare("INSERT INTO users (id, googleId, email, name, avatar, role) VALUES (?, ?, ?, ?, ?, ?)").run(
          user.id, user.googleId, user.email, user.name, user.avatar, user.role
        );

        // Notify Admin
        if (resend && process.env.ADMIN_EMAIL) {
          await resend.emails.send({
            from: 'KagenonameTrade <onboarding@resend.dev>',
            to: process.env.ADMIN_EMAIL,
            subject: 'Pengguna Baru KagenonameTrade',
            html: `<p>Nama: ${user.name}</p><p>Email: ${user.email}</p><p>Waktu: ${new Date().toISOString()}</p>`
          });
        }
      } else {
        db.prepare("UPDATE users SET lastLogin = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
      }

      // Log login
      db.prepare("INSERT INTO login_logs (userId) VALUES (?)").run(user.id);

      const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, avatar: user.avatar }, JWT_SECRET, { expiresIn: "7d" });

      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      console.error("Auth error", err);
      res.status(500).send("Authentication failed");
    }
  });

  app.get("/api/auth/me", authenticate, (req: any, res) => {
    res.json(req.user);
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("auth_token");
    res.json({ success: true });
  });

  // Process Analysis Result Route (Market Data + DB)
  app.post("/api/process-analysis", authenticate, async (req: any, res) => {
    const analysisResult = req.body;
    console.log("Processing analysis result for pair:", analysisResult.pair);

    // Step 2: Fetch Real-time Market Data
    let marketData = null;
    try {
      if (analysisResult.assetType === 'crypto' && analysisResult.pair) {
        const symbol = analysisResult.pair.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        console.log(`Fetching Binance data for ${symbol}...`);
        const binanceRes = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        if (binanceRes.data && binanceRes.data.lastPrice) {
          marketData = {
            price: binanceRes.data.lastPrice,
            high: binanceRes.data.highPrice,
            low: binanceRes.data.lowPrice,
            bid: binanceRes.data.bidPrice,
            ask: binanceRes.data.askPrice
          };
        }
      } else if (analysisResult.assetType === 'forex' && analysisResult.pair && process.env.TWELVE_DATA_API_KEY) {
        const symbol = analysisResult.pair.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
        console.log(`Fetching Twelve Data for ${symbol}...`);
        const twelveRes = await axios.get(`https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${process.env.TWELVE_DATA_API_KEY}`);
        if (twelveRes.data && !twelveRes.data.code && twelveRes.data.close) {
          marketData = {
            price: twelveRes.data.close,
            high: twelveRes.data.high,
            low: twelveRes.data.low,
            bid: twelveRes.data.bid || twelveRes.data.close,
            ask: twelveRes.data.ask || twelveRes.data.close
          };
        }
      }
    } catch (marketErr: any) {
      console.error("Market data fetch error (non-fatal):", marketErr.message);
    }

    console.log("Final analysis result to be saved:", JSON.stringify(analysisResult, null, 2));

    // Step 3: Save to DB
    const analysisId = uuidv4();
    try {
      console.log("Saving to database...");
      db.prepare("INSERT INTO analyses (id, userId, ocrText, result, confidence, pair, assetType) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        analysisId, 
        req.user.id, 
        analysisResult.ocrText || "", 
        JSON.stringify({ ...analysisResult, marketData }), 
        Number(analysisResult.confidence) || 0, 
        analysisResult.pair || "UNKNOWN", 
        analysisResult.assetType || "UNKNOWN"
      );
      console.log("Database save successful");
    } catch (dbErr) {
      console.error("Database save error:", dbErr);
    }

    res.json({ id: analysisId, ...analysisResult, marketData });
  });

  app.get("/api/analyses", authenticate, (req: any, res) => {
    const analyses = db.prepare("SELECT * FROM analyses WHERE userId = ? ORDER BY createdAt DESC").all(req.user.id);
    res.json(analyses.map((a: any) => ({ ...a, result: JSON.parse(a.result) })));
  });

  app.post("/api/analyses/:id/feedback", authenticate, (req: any, res) => {
    const { feedback } = req.body;
    db.prepare("UPDATE analyses SET feedback = ? WHERE id = ? AND userId = ?").run(feedback, req.params.id, req.user.id);
    res.json({ success: true });
  });

  // Admin Routes
  app.get("/api/admin/stats", authenticate, isAdmin, (req, res) => {
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
    const totalAnalyses = db.prepare("SELECT COUNT(*) as count FROM analyses").get() as any;
    const avgConfidence = db.prepare("SELECT AVG(confidence) as avg FROM analyses").get() as any;
    const feedbackStats = db.prepare("SELECT feedback, COUNT(*) as count FROM analyses WHERE feedback IS NOT NULL GROUP BY feedback").all() as any;
    
    res.json({
      totalUsers: totalUsers.count,
      totalAnalyses: totalAnalyses.count,
      avgConfidence: Math.round(avgConfidence.avg || 0),
      feedbackStats
    });
  });

  app.get("/api/admin/users", authenticate, isAdmin, (req, res) => {
    const users = db.prepare("SELECT * FROM users ORDER BY createdAt DESC").all();
    res.json(users);
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
