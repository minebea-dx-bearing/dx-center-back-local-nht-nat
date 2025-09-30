# Dockerfile

# เลือก base image ของ Node.js
FROM node:18

# กำหนด directory ภายใน container
WORKDIR /app

# คัดลอกไฟล์ทั้งหมดไปยัง container
COPY . .

# ติดตั้ง dependencies ตามไฟล์ lock
RUN npm install

# เปิด port 3001 สำหรับ container
EXPOSE 3001

# กำหนดคำสั่งเริ่มต้นสำหรับ container
CMD ["node", "server"]