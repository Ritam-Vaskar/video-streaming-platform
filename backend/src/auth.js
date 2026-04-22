import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import path from "node:path";

const usersFile = process.env.USERS_FILE || "/app/media/users/users.json";
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
const jwtExpiry = process.env.JWT_EXPIRY || "12h";

function extractBearerToken(headerValue = "") {
  const [scheme, token] = String(headerValue).split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export class AuthService {
  constructor() {
    this.users = [];
  }

  async init() {
    await fs.mkdir(path.dirname(usersFile), { recursive: true });

    try {
      const raw = await fs.readFile(usersFile, "utf8");
      const parsed = JSON.parse(raw);
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch {
      this.users = [];
    }

    if (!this.users.length) {
      this.users = await this.seedUsers();
      await this.persist();
    }
  }

  async seedUsers() {
    const broadcasterEmail = process.env.DEFAULT_BROADCASTER_EMAIL || "broadcaster@pulsecast.local";
    const broadcasterPassword = process.env.DEFAULT_BROADCASTER_PASSWORD || "Broadcaster@123";
    const viewerEmail = process.env.DEFAULT_VIEWER_EMAIL || "viewer@pulsecast.local";
    const viewerPassword = process.env.DEFAULT_VIEWER_PASSWORD || "Viewer@123";

    return [
      {
        id: "u_broadcaster",
        email: broadcasterEmail.toLowerCase(),
        role: "broadcaster",
        passwordHash: await bcrypt.hash(broadcasterPassword, 10)
      },
      {
        id: "u_viewer",
        email: viewerEmail.toLowerCase(),
        role: "viewer",
        passwordHash: await bcrypt.hash(viewerPassword, 10)
      }
    ];
  }

  async persist() {
    await fs.writeFile(usersFile, JSON.stringify({ users: this.users }, null, 2));
  }

  sanitizeUser(user) {
    return {
      id: user.id,
      email: user.email,
      role: user.role
    };
  }

  async register({ email, password, role = "viewer" }) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !password) {
      throw new Error("Email and password are required");
    }

    if (this.users.some((user) => user.email === normalized)) {
      throw new Error("User already exists");
    }

    const safeRole = role === "broadcaster" || role === "admin" ? role : "viewer";

    const user = {
      id: `u_${Date.now()}`,
      email: normalized,
      role: safeRole,
      passwordHash: await bcrypt.hash(password, 10)
    };

    this.users.push(user);
    await this.persist();
    return this.sanitizeUser(user);
  }

  async login({ email, password }) {
    const normalized = String(email || "").trim().toLowerCase();
    const user = this.users.find((entry) => entry.email === normalized);

    if (!user) {
      throw new Error("Invalid credentials");
    }

    const ok = await bcrypt.compare(password || "", user.passwordHash);
    if (!ok) {
      throw new Error("Invalid credentials");
    }

    const token = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role
      },
      jwtSecret,
      { expiresIn: jwtExpiry }
    );

    return {
      token,
      user: this.sanitizeUser(user)
    };
  }

  verifyToken(token) {
    return jwt.verify(token, jwtSecret);
  }

  authMiddleware({ roles = [] } = {}) {
    return (req, res, next) => {
      try {
        const token = extractBearerToken(req.headers.authorization);
        if (!token) {
          return res.status(401).json({ message: "Missing bearer token" });
        }

        const decoded = this.verifyToken(token);
        req.user = decoded;

        if (roles.length && !roles.includes(decoded.role)) {
          return res.status(403).json({ message: "Forbidden for this role" });
        }

        return next();
      } catch {
        return res.status(401).json({ message: "Invalid or expired token" });
      }
    };
  }

  socketUser(socket) {
    const token = socket.handshake?.auth?.token;
    if (!token) {
      return null;
    }

    try {
      return this.verifyToken(token);
    } catch {
      return null;
    }
  }
}

export function isBroadcasterRole(role) {
  return role === "broadcaster" || role === "admin";
}
