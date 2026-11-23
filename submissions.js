async function compressImageFile(file, maxWidth = 1400, quality = 0.82) {
  // Skip compression for tiny files (< 350 KB) or GIFs
  if (file.size < 350 * 1024 || file.type === "image/gif") {
    return file;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            resolve(file);
          } else {
            const cleanName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
            resolve(new File([blob], cleanName, { type: "image/jpeg" }));
          }
        },
        "image/jpeg",
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}

export async function uploadImagesToCloudinary(fileInputId, required = false) {
  const input = document.getElementById(fileInputId);
  if (!input || !input.files || input.files.length === 0) {
    if (required) throw new Error("Please attach the required image(s).");
    return [];
  }

  const check = validateImageFiles(input.files);
  if (!check.valid) throw new Error(check.error);

  const urls = [];
  for (const rawFile of check.files) {
    const fileToUpload = await compressImageFile(rawFile);
    const formData = new FormData();
    formData.append("file", fileToUpload);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: "POST", body: formData }
    );
    const data = await res.json();
    if (!data.secure_url) throw new Error(data.error?.message || "Image upload failed.");
    urls.push(data.secure_url);
  }
  return urls;
}
