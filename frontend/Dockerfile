FROM node:20-alpine AS build

WORKDIR /app

ARG VITE_API_URL=http://localhost:5000
ARG VITE_HLS_URL=http://localhost:8080/hls
ARG VITE_SOCKET_URL=http://localhost:5000

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_HLS_URL=$VITE_HLS_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
